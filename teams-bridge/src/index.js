/**
 * Teams Bridge
 *
 * Nimmt Nachrichten aus Microsoft Teams entgegen, prueft sie, reicht sie an n8n
 * weiter und schickt Antworten zurueck.
 *
 * Warum ein eigener Dienst und nicht ein Code-Baustein in n8n: Microsoft
 * verlangt, dass jede eingehende Nachricht gegen ein rotierendes Schluesselset
 * geprueft wird, und schreibt ausdruecklich, es duerfe keinen Weg geben, diese
 * Pruefung abzuschalten. In n8n laege diese Logik in einem Textfeld in der
 * Oberflaeche, angewiesen auf freigeschaltete Zusatzmodule, und ein
 * versehentliches "bei Fehler fortfahren" wuerde den Endpunkt oeffnen.
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');

const PORT = parseInt(process.env.PORT || '3401', 10);
const APP_ID = process.env.MS_APP_ID || '';
const APP_PASSWORD = process.env.MS_APP_PASSWORD || '';
const TENANT_ID = process.env.MS_TENANT_ID || '';
const N8N_WEBHOOK = process.env.N8N_TEAMS_WEBHOOK || '';
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || '';
// Fuer Nachrichten, die Rupert von sich aus anstoesst (Bote): die Dienstadresse
// kommt sonst nur mit eingehenden Nachrichten mit. EMEA ist der Standard fuer
// den SLT-Mandanten, gemessen am 03.09.2026.
const SERVICE_URL_FALLBACK = process.env.MS_SERVICE_URL || 'https://smba.trafficmanager.net/emea/';

const OPENID = 'https://login.botframework.com/v1/.well-known/openidconfiguration';
const ISSUER = 'https://api.botframework.com';

const app = express();
app.use(express.json({ limit: '2mb' }));

const log = (...a) => console.log(new Date().toISOString(), ...a);

// --- Schluesselsatz. jwks-rsa haelt den Cache und holt neue Schluessel selbst,
// Microsoft verlangt eine Erneuerung mindestens alle 24 Stunden.
let keyClient = null;
async function getKeyClient() {
  if (keyClient) return keyClient;
  const conf = await (await fetch(OPENID)).json();
  keyClient = jwksClient({
    jwksUri: conf.jwks_uri,
    cache: true,
    cacheMaxAge: 6 * 60 * 60 * 1000,
    rateLimit: true
  });
  return keyClient;
}

async function verifyActivity(authHeader, activity) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) throw new Error('kein Bearer-Token');
  const token = authHeader.slice(7);
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || !decoded.header || !decoded.header.kid) throw new Error('Token nicht lesbar');

  const client = await getKeyClient();
  const key = await client.getSigningKey(decoded.header.kid);

  // Prueft Signatur (RS256), Aussteller, Zielgruppe, Gueltigkeit mit 5 Minuten
  // Toleranz. Schlaegt eine davon fehl, wirft verify.
  const claims = jwt.verify(token, key.getPublicKey(), {
    algorithms: ['RS256'],
    issuer: ISSUER,
    audience: APP_ID,
    clockTolerance: 300
  });

  // Die siebte Pruefung, die keine Bibliothek uebernimmt: die Dienstadresse im
  // Token muss der in der Nachricht entsprechen. Ohne sie liesse sich der Bot
  // dazu bringen, seine Antwort an einen fremden Server zu schicken.
  const inToken = String(claims.serviceurl || claims.serviceUrl || '').replace(/\/$/, '');
  const inActivity = String((activity && activity.serviceUrl) || '').replace(/\/$/, '');
  if (!inToken || inToken !== inActivity) {
    throw new Error('serviceUrl im Token passt nicht zur Nachricht');
  }
  return claims;
}

// --- Doppelte Zustellungen. Teams wiederholt nach 15 Sekunden ohne Antwort,
// und Rupert braucht regelmaessig laenger.
const gesehen = new Map();
function schonGesehen(id) {
  const jetzt = Date.now();
  for (const [k, t] of gesehen) if (jetzt - t > 5 * 60 * 1000) gesehen.delete(k);
  if (!id) return false;
  if (gesehen.has(id)) return true;
  gesehen.set(id, jetzt);
  return false;
}

// --- Eigene Erwaehnung aus dem Text entfernen, fremde stehen lassen.
function textOhneErwaehnung(activity) {
  let text = activity.text || '';
  const eigenId = ((activity.recipient || {}).id || '').toLowerCase();
  for (const e of (activity.entities || [])) {
    if (e.type === 'mention' && e.text && ((e.mentioned || {}).id || '').toLowerCase() === eigenId) {
      text = text.split(e.text).join(' ');
    }
  }
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function anBot(activity) {
  const eigenId = ((activity.recipient || {}).id || '').toLowerCase();
  return (activity.entities || []).some(
    e => e.type === 'mention' && ((e.mentioned || {}).id || '').toLowerCase() === eigenId
  );
}

// --- Token fuer ausgehende Nachrichten, gecacht bis kurz vor Ablauf.
let botToken = { wert: null, bis: 0 };
let botTokenLauf = null; // laufender Abruf, damit parallele Aufrufer nicht je ein Token holen
async function getBotToken() {
  if (botToken.wert && Date.now() < botToken.bis - 60000) return botToken.wert;
  if (botTokenLauf) return botTokenLauf;
  botTokenLauf = (async () => {
    const url = 'https://login.microsoftonline.com/' + encodeURIComponent(TENANT_ID) + '/oauth2/v2.0/token';
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: APP_ID,
      client_secret: APP_PASSWORD,
      scope: 'https://api.botframework.com/.default'
    });
    const r = await fetch(url, { method: 'POST', body });
    if (!r.ok) throw new Error('Bot-Token: HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    botToken = { wert: j.access_token, bis: Date.now() + (j.expires_in || 3600) * 1000 };
    return botToken.wert;
  })().finally(() => { botTokenLauf = null; });
  return botTokenLauf;
}

async function sende(serviceUrl, conversationId, aktivitaet, versuch = 0) {
  const token = await getBotToken();
  const url = String(serviceUrl).replace(/\/$/, '') + '/v3/conversations/' + encodeURIComponent(conversationId) + '/activities';
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(aktivitaet)
  });
  if (r.ok) return true;
  const text = (await r.text()).slice(0, 300);
  // Microsoft nennt neben 429 ausdruecklich 412, 502 und 504 als zu wiederholen.
  if ([429, 412, 502, 504].includes(r.status) && versuch < 3) {
    await new Promise(res => setTimeout(res, (2 ** versuch) * 500 + Math.random() * 300));
    return sende(serviceUrl, conversationId, aktivitaet, versuch + 1);
  }
  throw new Error('Senden fehlgeschlagen: HTTP ' + r.status + ' ' + text);
}

// --- Tipp-Signal. Teams zeigt "Rupert schreibt..." nur wenige Sekunden je
// Signal, deshalb wiederholen, bis die Antwort ueber /reply kommt. Hoechstens
// fuenf Minuten, falls nie eine Antwort kommt. In Kanaelen zeigt Teams das
// Signal nicht an, es schadet dort aber auch nicht.
const wartend = new Map();
function tippenStop(conversationId) {
  const w = wartend.get(conversationId);
  if (!w) return;
  clearInterval(w.timer);
  wartend.delete(conversationId);
}
function tippenStart(serviceUrl, conversationId) {
  if (!serviceUrl || !conversationId) return;
  tippenStop(conversationId);
  const tick = () => sende(serviceUrl, conversationId, { type: 'typing' }).catch(e => log('typing:', e.message));
  tick();
  const timer = setInterval(tick, 4000);
  wartend.set(conversationId, { timer, bis: Date.now() + 5 * 60 * 1000 });
  setTimeout(() => { const w = wartend.get(conversationId); if (w && w.timer === timer) tippenStop(conversationId); }, 11 * 60 * 1000);
}

// --- Dienstadresse je Mandant merken (fuer den Boten).
const dienstAdresse = new Map();
function dienstAdresseFuer(tenantId) {
  return dienstAdresse.get(tenantId || '') || [...dienstAdresse.values()][0] || SERVICE_URL_FALLBACK;
}

// --- Grobes Rate-Limit fuer den Boten: 30 Nachrichten je 10 Minuten insgesamt.
const gesendetZeiten = [];
function boteErlaubt() {
  const jetzt = Date.now();
  while (gesendetZeiten.length && jetzt - gesendetZeiten[0] > 10 * 60 * 1000) gesendetZeiten.shift();
  if (gesendetZeiten.length >= 30) return false;
  gesendetZeiten.push(jetzt);
  return true;
}

// --- Mitgliedsereignisse. Teams meldet dem Bot, wenn Rupert fuer eine Person
// installiert wird (auch durch die Admin-Richtlinie) oder wieder verschwindet:
// installationUpdate mit action add/remove, im persoenlichen Chat zusaetzlich
// ein conversationUpdate, in dem der Bot unter membersAdded steht. Bis 08.09.2026
// wurden beide ungelesen verworfen, deshalb war nicht zu sehen, wer angekommen
// ist. Jetzt werden sie protokolliert, und eine neue Installation im
// persoenlichen Chat geht an den Adapter, der das Profil anlegt und begruesst.
const kurz = s => String(s || '').slice(0, 8);
function mitgliedschaftAusActivity(activity) {
  const a = activity || {};
  const from = a.from || {};
  const conv = a.conversation || {};
  const liste = l => (Array.isArray(l) ? l : []).filter(m => m && typeof m === 'object');
  const botId = ('28:' + APP_ID).toLowerCase();
  const istBot = m => String(m.id || '').toLowerCase() === botId;
  const hinzu = liste(a.membersAdded);
  const weg = liste(a.membersRemoved);
  const personHinzu = hinzu.find(m => !istBot(m) && m.aadObjectId) || {};
  return {
    typ: String(a.type || ''),
    action: String(a.action || ''),
    aadObjectId: from.aadObjectId || personHinzu.aadObjectId || '',
    fromName: from.name || personHinzu.name || '',
    fromId: from.id || personHinzu.id || '',
    conversationId: conv.id || '',
    conversationType: conv.conversationType || '',
    tenantId: ((a.channelData || {}).tenant || {}).id || conv.tenantId || '',
    serviceUrl: a.serviceUrl || '',
    hinzu: hinzu.map(m => m.aadObjectId || m.id || ''),
    weg: weg.map(m => m.aadObjectId || m.id || ''),
    botHinzu: hinzu.some(istBot),
    botWeg: weg.some(istBot),
    zeit: a.timestamp || ''
  };
}
// Neue Installation im persoenlichen Chat? Beide Ereignisformen zaehlen, weil
// Microsoft fuer die Vorinstallation per Richtlinie nicht zusichert, welches
// davon kommt. Dubletten faengt installationMelden ueber die Objekt-ID ab.
function istNeueInstallation(m) {
  if (!m || m.conversationType !== 'personal' || !m.aadObjectId) return false;
  if (m.typ === 'installationUpdate') return m.action === 'add';
  if (m.typ === 'conversationUpdate') return m.botHinzu && !m.botWeg;
  return false;
}
const installiertKuerzlich = new Map();
async function installationMelden(m) {
  if (!m.conversationId || !m.serviceUrl) return log('installation: ohne Konversation oder Dienstadresse, uebersprungen');
  const jetzt = Date.now();
  for (const [k, t] of installiertKuerzlich) if (jetzt - t > 10 * 60 * 1000) installiertKuerzlich.delete(k);
  if (installiertKuerzlich.has(m.aadObjectId)) return log('installation: schon gemeldet', kurz(m.aadObjectId));
  installiertKuerzlich.set(m.aadObjectId, jetzt);
  if (m.tenantId && m.serviceUrl) dienstAdresse.set(m.tenantId, m.serviceUrl);

  try {
    // Im Installationsereignis fehlt der Name meist. Die Mitgliederabfrage der
    // Konversation liefert Anzeigename sowie Vor- und Nachname. Die Mailadresse
    // liefert sie auch, die wird aber nicht weitergegeben: der Adapter braucht
    // sie nicht, und n8n bewahrt Eingabedaten von Executions auf.
    let person = {};
    try {
      const token = await getBotToken();
      const url = String(m.serviceUrl).replace(/\/$/, '') + '/v3/conversations/' + encodeURIComponent(m.conversationId) + '/members';
      const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
      if (r.ok) {
        const mitglieder = await r.json();
        const l = Array.isArray(mitglieder) ? mitglieder.filter(x => x && typeof x === 'object') : [];
        person = l.find(x => x.aadObjectId === m.aadObjectId) || (l.length === 1 ? l[0] : {});
      } else {
        log('installation: Mitglieder HTTP', r.status, (await r.text()).slice(0, 120));
      }
    } catch (e) { log('installation: Mitglieder', e.message); }
    // Ohne Person aus der Abfrage die Sperre freigeben: das zweite Ereignis derselben
    // Installation (Teams schickt zwei) darf die Abfrage wiederholen. Doppelt
    // begruesst wird trotzdem nicht, der Adapter erkennt die Verlaufszeile.
    if (!person.aadObjectId && !person.name) installiertKuerzlich.delete(m.aadObjectId);

    const nutzlast = {
      event: 'installiert',
      text: '',
      aadObjectId: m.aadObjectId,
      fromName: person.name || m.fromName || '',
      givenName: person.givenName || '',
      surname: person.surname || '',
      fromId: person.id || m.fromId || '',
      conversationId: m.conversationId,
      conversationType: m.conversationType,
      serviceUrl: m.serviceUrl,
      tenantId: person.tenantId || m.tenantId || '',
      activityId: ''
    };
    log('installation gemeldet:', nutzlast.fromName || '(ohne Name)', '|', kurz(m.aadObjectId));
    const r = await fetch(N8N_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Secret': BRIDGE_SECRET },
      body: JSON.stringify(nutzlast)
    });
    if (!r.ok) throw new Error('n8n HTTP ' + r.status);
  } catch (e) {
    // Sperre zuruecknehmen: das zweite Ereignis derselben Installation darf es
    // dann noch einmal versuchen.
    installiertKuerzlich.delete(m.aadObjectId);
    throw e;
  }
}

// Meldungen nacheinander mit Abstand, damit ein Rollout der Admin-Richtlinie
// an viele Personen auf einmal nicht in einen Schwall aus Token-Abrufen,
// Mitgliederabfragen und Begruessungen ausartet (Bot-Framework-Limits).
let installWarteschlange = Promise.resolve();
function installationEinreihen(m) {
  installWarteschlange = installWarteschlange
    .then(() => installationMelden(m))
    .catch(e => log('installation fehlgeschlagen:', e.message))
    .then(() => new Promise(res => setTimeout(res, 400)));
}

// --- Eingang von Teams -------------------------------------------------------
app.post('/messages', async (req, res) => {
  const activity = req.body || {};
  try {
    await verifyActivity(req.headers.authorization, activity);
  } catch (e) {
    log('abgewiesen:', e.message);
    return res.status(403).send('forbidden');
  }

  // Sofort quittieren. Die Antwort kommt spaeter als eigener Aufruf, sonst
  // wiederholt Teams nach 15 Sekunden und die Person sieht alles doppelt.
  res.status(200).end();

  try {
    if (schonGesehen(activity.id)) return log('doppelt, ignoriert:', activity.id);
    if (activity.type === 'installationUpdate' || activity.type === 'conversationUpdate') {
      // Eigener Fehlerrahmen: hier darf nie die Entschuldigung aus dem catch
      // unten in den Chat gehen, die Person hat ja nichts geschrieben.
      try {
        const m = mitgliedschaftAusActivity(activity);
        log('mitgliedschaft:', m.typ, m.action || (m.botHinzu ? 'bot hinzu' : m.botWeg ? 'bot weg' : ''),
          '|', m.conversationType || '?', '|', m.fromName || '(ohne Name)', kurz(m.aadObjectId),
          '| hinzu', m.hinzu.map(kurz).join(',') || '-', '| weg', m.weg.map(kurz).join(',') || '-',
          '| tenant', kurz(m.tenantId), '| konv', kurz(m.conversationId));
        if (istNeueInstallation(m)) installationEinreihen(m);
      } catch (e) { log('mitgliedschaft: Fehler', e.message); }
      return;
    }
    if (activity.type !== 'message') return log('ignoriert, Typ', activity.type);

    const imKanal = (activity.conversation || {}).conversationType !== 'personal';
    if (imKanal && !anBot(activity)) return log('im Kanal ohne Erwaehnung, ignoriert');

    const nutzlast = {
      text: textOhneErwaehnung(activity),
      aadObjectId: (activity.from || {}).aadObjectId || '',
      fromName: (activity.from || {}).name || '',
      fromId: (activity.from || {}).id || '',
      conversationId: (activity.conversation || {}).id || '',
      conversationType: (activity.conversation || {}).conversationType || '',
      serviceUrl: activity.serviceUrl || '',
      tenantId: ((activity.channelData || {}).tenant || {}).id || '',
      activityId: activity.id || ''
    };
    if (!nutzlast.text) return log('leerer Text, ignoriert');
    if (nutzlast.tenantId && nutzlast.serviceUrl) dienstAdresse.set(nutzlast.tenantId, nutzlast.serviceUrl);
    tippenStart(nutzlast.serviceUrl, nutzlast.conversationId);

    log('weitergereicht:', nutzlast.fromName, '|', nutzlast.text.slice(0, 60));
    const r = await fetch(N8N_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Secret': BRIDGE_SECRET },
      body: JSON.stringify(nutzlast)
    });
    if (!r.ok) throw new Error('n8n: HTTP ' + r.status);
  } catch (e) {
    log('Fehler nach der Quittung:', e.message);
    tippenStop((activity.conversation || {}).id);
    try {
      await sende(activity.serviceUrl, (activity.conversation || {}).id,
        { type: 'message', text: 'Da ist mir gerade etwas dazwischengekommen. Bitte noch einmal versuchen.' });
    } catch (_e) {}
  }
});

// --- Ausgang, von n8n aufgerufen --------------------------------------------
app.post('/reply', async (req, res) => {
  if (!BRIDGE_SECRET || req.headers['x-bridge-secret'] !== BRIDGE_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const { serviceUrl, conversationId, text, stop } = req.body || {};
  // Nur das Tipp-Signal beenden, etwa wenn der Adapter abbricht.
  if (stop && conversationId && !text) { tippenStop(conversationId); return res.json({ ok: true, stopped: true }); }
  if (!serviceUrl || !conversationId || !text) {
    return res.status(400).json({ error: 'serviceUrl, conversationId und text sind noetig' });
  }
  tippenStop(conversationId);
  try {
    await sende(serviceUrl, conversationId, { type: 'message', text: String(text) });
    res.json({ ok: true });
  } catch (e) {
    log('reply fehlgeschlagen:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// --- Bote: Nachricht an eine Person, die die App installiert hat. Erst wird
// eine Konversation angelegt (bei bestehendem Chat liefert Teams dieselbe ID),
// dann die Nachricht geschickt. 403 heisst: die Person hat Rupert in Teams
// noch nie geoeffnet, dann gibt es keinen Chat, in den wir schreiben duerften.
app.post('/send', async (req, res) => {
  if (!BRIDGE_SECRET || req.headers['x-bridge-secret'] !== BRIDGE_SECRET) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  const { aadObjectId, text, tenantId } = req.body || {};
  if (!aadObjectId || !text) return res.status(400).json({ ok: false, error: 'aadObjectId und text sind noetig' });
  if (String(text).length > 2000) return res.status(400).json({ ok: false, error: 'text zu lang (max 2000)' });
  if (!boteErlaubt()) return res.status(429).json({ ok: false, error: 'rate_limit', grund: 'zu viele Nachrichten in kurzer Zeit' });
  const serviceUrl = dienstAdresseFuer(tenantId || TENANT_ID);
  try {
    const token = await getBotToken();
    const r = await fetch(String(serviceUrl).replace(/\/$/, '') + '/v3/conversations', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bot: { id: '28:' + APP_ID },
        members: [{ id: String(aadObjectId) }],
        channelData: { tenant: { id: tenantId || TENANT_ID } },
        isGroup: false
      })
    });
    if (r.status === 403) {
      const t = (await r.text()).slice(0, 200);
      log('send: nicht installiert', aadObjectId.slice(0, 8), t);
      return res.status(403).json({ ok: false, grund: 'nicht_installiert' });
    }
    if (!r.ok) throw new Error('Konversation: HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const conv = await r.json();
    await sende(serviceUrl, conv.id, { type: 'message', text: String(text) });
    log('send: zugestellt an', aadObjectId.slice(0, 8));
    res.json({ ok: true, conversationId: conv.id });
  } catch (e) {
    log('send fehlgeschlagen:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.get('/health', (req, res) => res.json({
  ok: true,
  appId: APP_ID ? APP_ID.slice(0, 8) + '...' : 'fehlt',
  n8n: N8N_WEBHOOK ? 'gesetzt' : 'fehlt',
  gesehen: gesehen.size,
  tippend: wartend.size,
  dienstAdressen: dienstAdresse.size
}));

if (require.main === module) {
  app.listen(PORT, () => log('Teams Bridge laeuft auf Port', PORT));
}

// Fuer die Tests (tests/teams-bridge-mitgliedschaft.test.js), ohne Server.
module.exports = { mitgliedschaftAusActivity, istNeueInstallation };
