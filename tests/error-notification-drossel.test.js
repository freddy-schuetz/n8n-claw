// Prueft die Drossel der Error Notification (Runde 11 Teilrunde 2, B40, E4) mit
// dem ECHTEN Code aus workflows/error-notification.json: Knoten "Drosseln" und
// "Log Error to memory_long" gegen eine nachgebaute memory_long-Tabelle
// (PostgREST: GET mit Filtern, POST mit return=representation, PATCH und
// DELETE nach id). Dazu die Struktur: Kette statt Gabel, Telegram-Knoten
// unveraendert, settings ohne errorWorkflow. Seit der Durchsicht vom 25.10.:
// zum Deckel zaehlen nur Zeilen, die bleiben (gleichzeitige gemischte Fehler),
// die aeltesten Zeilen entscheiden auch ueber 50 gleichzeitige Laeufe hinaus,
// und eine Reservierung schaltet nur zwei Minuten lang stumm.
// Anlass: am 25.09.2026 scheiterte der Reminder Runner 501-mal; mit
// errorWorkflow ueberall und ohne Drossel waeren das 501 Telegram-Meldungen und
// 501 Gedaechtniszeilen gewesen.
//   node tests/error-notification-drossel.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'error-notification.json'), 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const knoten = (name) => wf.nodes.find(n => n.name === name);

function loadCode(name) {
  const k = knoten(name);
  if (!k || !(k.parameters || {}).jsCode) throw new Error('Knoten ' + name + ' nicht gefunden');
  return k.parameters.jsCode
    .replace(/\{\{SUPABASE_URL\}\}/g, 'http://stub.local')
    .replace(/\{\{SUPABASE_SERVICE_KEY\}\}/g, 'stub-key');
}

let n = 0, fehler = 0;
async function fall(name, fn) {
  n++;
  try { await fn(); console.log('PASS', name); }
  catch (e) { fehler++; console.log('FAIL', name, '\n     ', e.message); }
}

const STUNDE = 3600 * 1000;
const TAGE30 = 30 * 24 * STUNDE;

// PostgREST-Filter metadata->>feld=eq.wert oder =is.null (Text-Vergleich wie ->>).
function bedingungen(r, s) {
  for (const [k, v] of s.entries()) {
    if (!k.startsWith('metadata->>')) continue;
    const ist = (r.metadata || {})[k.slice('metadata->>'.length)];
    if (v === 'is.null') {
      if (ist !== undefined && ist !== null) return false;
    } else if (!v.startsWith('eq.') || ist === undefined || ist === null || String(ist) !== v.slice(3)) {
      return false;
    }
  }
  return true;
}

// Nachgebaute memory_long hinter PostgREST. Jede Anfrage muss apikey UND
// Authorization Bearer tragen, und der Fehlertext darf nie in der Adresse
// stehen; Verstoesse werden gesammelt (eine Ausnahme schluckte der Knoten).
function tabelle() {
  const t = { rows: [], next: 1, calls: [], verstoesse: [], verboten: [], stoerung: {}, verzoegern: false };
  const auswahl = (r, sel) => {
    if (!sel) return JSON.parse(JSON.stringify(r));
    const o = {};
    for (const f of sel.split(',')) o[f] = JSON.parse(JSON.stringify(r[f] === undefined ? null : r[f]));
    return o;
  };
  t.helpers = { httpRequest: async (req) => {
    if (t.verzoegern) await new Promise(r => setImmediate(r));
    const url = new URL(String(req.url));
    const m = req.method;
    t.calls.push({ m, url: String(req.url), headers: req.headers, body: req.body });
    const h = req.headers || {};
    if (h.apikey !== 'stub-key' || h.Authorization !== 'Bearer stub-key') t.verstoesse.push(m + ' ohne apikey und Bearer');
    for (const v of t.verboten) if (String(req.url).toLowerCase().includes(v)) t.verstoesse.push('Fehlertext in der Adresse: ' + v);
    if (url.pathname !== '/rest/v1/memory_long') t.verstoesse.push('falsche Tabelle ' + url.pathname);
    const s = url.searchParams;
    const st = t.stoerung;
    if (st.alles) throw new Error('connect ECONNREFUSED');
    if (m === 'GET') {
      t.gets = (t.gets || 0) + 1;
      if (st.get && st.get(t.gets)) throw new Error('read ECONNRESET');
      if (st.keineListe) return { message: 'JWT expired' };
      if (s.get('id')) {
        const id = Number(s.get('id').replace(/^eq\./, ''));
        return t.rows.filter(r => r.id === id).map(r => auswahl(r, s.get('select')));
      }
      const wk = String(s.get('metadata->>wf_kennung') || '').replace(/^eq\./, '');
      const seit = Date.parse(String(s.get('created_at') || '').replace(/^gt\./, ''));
      if (s.get('scope') !== 'eq.betrieb' || s.get('category') !== 'eq.error' || !wk || !Number.isFinite(seit)) {
        t.verstoesse.push('GET ohne die Filter scope, category, wf_kennung, created_at: ' + url.search);
      }
      // Die aeltesten Zeilen entscheiden: gelesen wird nach id aufsteigend (mit
      // absteigender Ordnung fielen bei mehr als 50 Zeilen genau die weg).
      const ord = s.get('order');
      if (ord !== 'id.asc') t.verstoesse.push('GET nicht nach id aufsteigend: ' + ord);
      return t.rows.filter(r => r.scope === 'betrieb' && r.category === 'error' && (r.metadata || {}).wf_kennung === wk
        && Date.parse(r.created_at) > seit)
        .sort((a, b) => ord === 'id.asc' ? a.id - b.id : ((Date.parse(b.created_at) - Date.parse(a.created_at)) || (b.id - a.id)))
        .slice(0, Number(s.get('limit') || 1000)).map(r => auswahl(r, s.get('select')));
    }
    if (m === 'POST') {
      if (st.post) throw new Error('500');
      const b = JSON.parse(req.body);
      const r = Object.assign({ id: t.next++, created_at: new Date().toISOString() }, b);
      t.rows.push(r);
      // Angelegt, aber die Antwort kommt nach dem Zeitlimit des Knotens.
      if (st.postAntwortWeg) throw new Error('timeout of 5000ms exceeded');
      if (st.postOhneId) return [];
      if (!String((h.Prefer || '')).includes('return=representation')) return '';
      return [auswahl(r, s.get('select'))];
    }
    if (m === 'PATCH') {
      if (st.patch) throw new Error('500');
      // Schreiben nur mit Bedingung auf telegram, wiederholt und ueber_deckel
      // (sonst ueberschriebe ein Zaehler den Zustellvermerk oder umgekehrt).
      for (const f of ['telegram', 'wiederholt', 'ueber_deckel']) {
        if (!s.has('metadata->>' + f)) t.verstoesse.push('PATCH ohne Bedingung auf ' + f);
      }
      const id = Number(String(s.get('id') || '').replace(/^eq\./, ''));
      const treffer = t.rows.filter(x => x.id === id && bedingungen(x, s));
      for (const r of treffer) Object.assign(r, JSON.parse(req.body));
      if (!String(h.Prefer || '').includes('return=representation')) return '';
      return treffer.map(r => auswahl(r, s.get('select')));
    }
    if (m === 'DELETE') {
      if (st.delete) throw new Error('500');
      const id = Number(String(s.get('id') || '').replace(/^eq\./, ''));
      t.rows = t.rows.filter(x => x.id !== id);
      return '';
    }
    t.verstoesse.push('unerwartet ' + m);
    return '';
  } };
  return t;
}

let drosseln, loggen;
try {
  drosseln = new AsyncFunction('$input', '$', 'helpers', loadCode('Drosseln'));
  loggen = new AsyncFunction('$input', '$', 'helpers', loadCode('Log Error to memory_long'));
} catch (e) {
  console.log('FAIL Knoten der Drossel fehlen:', e.message);
  process.exit(1);
}
const TG_OK = { ok: true, result: { message_id: 4711 } };

// Ein Fehlerlauf durch die Kette: Drosseln, (Telegram), Log. Telegram wird hier
// nicht gerufen; tg ist seine Ausgabe (Erfolg oder continueOnFail-Element).
async function lauf(t, fehlerDaten, tg) {
  const aus = await drosseln({ first: () => ({ json: fehlerDaten }) }, () => { throw new Error('$ in Drosseln'); }, t.helpers);
  if (!Array.isArray(aus)) throw new Error('Drosseln gibt keine Liste zurueck');
  if (!aus.length) return { gesendet: false };
  const $ = (name) => ({ first: () => { if (name === 'Drosseln') return aus[0]; throw new Error('unbekannter Knoten ' + name); } });
  const log = await loggen({ first: () => ({ json: tg || TG_OK }) }, $, t.helpers);
  return { gesendet: true, item: aus[0].json, log: log[0].json };
}
const F = (wfid, msg, extra) => ({ workflow: { id: wfid, name: 'W ' + wfid },
  execution: Object.assign({ id: '202591', url: 'https://agent.sltg.at/workflow/' + wfid + '/executions/202591', mode: 'trigger',
    lastNodeExecuted: 'Check Reminders', error: { message: msg, name: 'NodeApiError', stack: 'Error: ' + msg + '\n    at x' } }, extra || {}) });
const ohneVerstoss = (t) => assert.deepEqual(t.verstoesse, []);
const posts = (t) => t.calls.filter(c => c.m === 'POST');

(async () => {
  console.log('--- Struktur ---');
  await fall('vier Knoten, Kette Error Trigger -> Drosseln -> Send Telegram Alert -> Log', async () => {
    assert.deepEqual(wf.nodes.map(k => k.name).sort(), ['Drosseln', 'Error Trigger', 'Log Error to memory_long', 'Send Telegram Alert']);
    const kante = (q) => ((wf.connections[q] || {}).main || [[]])[0].map(c => c.node);
    assert.deepEqual(kante('Error Trigger'), ['Drosseln']);
    assert.deepEqual(kante('Drosseln'), ['Send Telegram Alert']);
    assert.deepEqual(kante('Send Telegram Alert'), ['Log Error to memory_long']);
    assert.deepEqual(Object.keys(wf.connections).sort(), ['Drosseln', 'Error Trigger', 'Send Telegram Alert']);
  });
  await fall('Drosseln: Code v2, ohne continueOnFail; Log behaelt continueOnFail', async () => {
    const d = knoten('Drosseln');
    assert.equal(d.type, 'n8n-nodes-base.code');
    assert.equal(d.typeVersion, 2);
    assert.equal(d.continueOnFail, undefined);
    assert.equal(d.onError, undefined);
    assert.equal(knoten('Log Error to memory_long').continueOnFail, true);
  });
  await fall('Telegram-Knoten wie bisher: HTML mit Maskierung, Credential Telegram Bot, continueOnFail', async () => {
    const tgk = knoten('Send Telegram Alert');
    assert.equal(tgk.type, 'n8n-nodes-base.telegram');
    assert.equal(tgk.typeVersion, 1.2);
    assert.equal(tgk.parameters.additionalFields.parse_mode, 'HTML');
    assert.equal(tgk.parameters.chatId, '{{TELEGRAM_CHAT_ID}}');
    assert.equal(tgk.credentials.telegramApi.name, 'Telegram Bot');
    assert.equal(tgk.continueOnFail, true);
    const text = tgk.parameters.text;
    for (const feld of ['$json.workflow.name', '$json.execution.error?.message', '$json.execution.lastNodeExecuted']) {
      const i = text.indexOf(feld);
      assert.ok(i >= 0, feld);
      assert.ok(text.slice(i, i + 160).includes(".replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')"), 'Maskierung ' + feld);
    }
  });
  await fall('settings ohne errorWorkflow (sonst Schleife), kein $json, kein Bot-Token im Code', async () => {
    assert.deepEqual(wf.settings, { executionOrder: 'v1' });
    for (const name of ['Drosseln', 'Log Error to memory_long']) {
      const c = knoten(name).parameters.jsCode;
      const ohneKommentar = c.split('\n').filter(z => !z.trim().startsWith('//')).join('\n');
      assert.doesNotMatch(c, /\$json/, name);
      assert.doesNotMatch(c, /api\.telegram\.org|TELEGRAM_BOT_TOKEN/, name);
      assert.doesNotMatch(ohneKommentar, /entity_name|owner_user_id/, name);
    }
  });

  console.log('--- Drossel ---');
  await fall('erster Fehler: Meldung, eine Zeile scope betrieb, 30 Tage, ohne entity_name und owner_user_id', async () => {
    const t = tabelle();
    t.verboten = ['request failed with status code 503'];
    const r = await lauf(t, F('AePycfpOPQjQZ2W3', 'Request failed with status code 503'));
    ohneVerstoss(t);
    assert.equal(r.gesendet, true);
    assert.match(r.item._drossel.schluessel, /^en:AePycfpOPQjQZ2W3:[0-9a-f]{8}$/);
    assert.equal(r.item._drossel.wf_kennung, 'AePycfpOPQjQZ2W3');
    assert.equal(r.item.workflow.id, 'AePycfpOPQjQZ2W3');
    assert.equal(r.item.execution.error.message, 'Request failed with status code 503');
    assert.equal(posts(t).length, 1);
    assert.equal(t.rows.length, 1);
    const z = t.rows[0];
    assert.equal(z.scope, 'betrieb');
    assert.equal(z.category, 'error');
    assert.equal(z.importance, 8);
    assert.equal(z.source, 'error_notification');
    assert.equal(z.entity_name, undefined);
    assert.equal(z.owner_user_id, undefined);
    assert.ok(Math.abs(Date.parse(z.expires_at) - (Date.now() + TAGE30)) < 60000, 'expires_at 30 Tage');
    assert.match(z.content, /^Workflow error in "W AePycfpOPQjQZ2W3" at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC: Request failed with status code 503\. Failed at node "Check Reminders"\. Execution 202591: https:/);
    assert.equal(z.metadata.schluessel, r.item._drossel.schluessel);
    assert.equal(z.metadata.wf_kennung, 'AePycfpOPQjQZ2W3');
    assert.equal(z.metadata.telegram, 'ok');
    assert.equal(z.metadata.wiederholt, 0);
    assert.equal(z.metadata.ueber_deckel, 0);
    assert.equal(z.metadata.error_message, 'Request failed with status code 503');
    assert.equal(z.metadata.workflow_id, 'AePycfpOPQjQZ2W3');
    assert.ok(z.metadata.telegram_am);
    assert.equal(r.log.logged, true);
    assert.equal(r.log.telegram, 'ok');
  });
  await fall('Reminder Runner 25.09.: 501 gleiche Fehler -> 1 Meldung, 1 Zeile, wiederholt 500', async () => {
    const t = tabelle();
    let gesendet = 0;
    for (let i = 0; i < 501; i++) if ((await lauf(t, F('AePycfpOPQjQZ2W3', 'Request failed with status code 503'))).gesendet) gesendet++;
    ohneVerstoss(t);
    assert.equal(gesendet, 1);
    assert.equal(t.rows.length, 1);
    assert.equal(posts(t).length, 1);
    assert.equal(t.rows[0].metadata.wiederholt, 500);
    assert.equal(t.rows[0].metadata.telegram, 'ok');
    assert.ok(t.rows[0].metadata.zuletzt);
  });
  await fall('Schluessel: Zeitstempel, Ausfuehrungsnummer und UUID egal, Statuscodes getrennt', async () => {
    const key = async (msg) => (await drosseln({ first: () => ({ json: F('Z1', msg) }) }, null, tabelle().helpers))[0].json._drossel.schluessel;
    const a = await key('Timeout bei 2026-10-25T03:00:12.123Z in Ausfuehrung 203512 (Sitzung 6f1c2d3e-1111-4222-8333-944455556666)');
    const b = await key('Timeout bei 2026-10-26T04:10:00Z in Ausfuehrung 204000 (Sitzung 0a1b2c3d-aaaa-4bbb-8ccc-ddddeeeeffff)');
    assert.equal(a, b);
    assert.equal(await key('Fehler um 07:57'), await key('Fehler um 08:35:12'));
    assert.notEqual(await key('Request failed with status code 401'), await key('Request failed with status code 503'));
    assert.match(await key(''), /^en:Z1:[0-9a-f]{8}$/);
  });
  await fall('Deckel: 5 verschiedene Fehler im selben Workflow -> 3 Meldungen, ueber_deckel 2; anderer Workflow eigener Deckel', async () => {
    const t = tabelle();
    const ges = [];
    for (const x of 'abcde') ges.push((await lauf(t, F('84rG1jR3vdMXeNLm', 'Fehler ' + x))).gesendet);
    ohneVerstoss(t);
    assert.deepEqual(ges, [true, true, true, false, false]);
    assert.equal(t.rows.length, 3);
    assert.equal(t.rows[2].metadata.ueber_deckel, 2);
    assert.equal(t.rows[0].metadata.ueber_deckel + t.rows[1].metadata.ueber_deckel, 0);
    assert.equal((await lauf(t, F('TGSCr6Xe58KgEHYS', 'Fehler a'))).gesendet, true);
    assert.equal(t.rows.length, 4);
  });
  await fall('nach mehr als einer Stunde meldet derselbe Fehler wieder', async () => {
    const t = tabelle();
    await lauf(t, F('W1', 'x'));
    t.rows[0].created_at = new Date(Date.now() - 61 * 60000).toISOString();
    assert.equal((await lauf(t, F('W1', 'x'))).gesendet, true);
    assert.equal(t.rows.length, 2);
    ohneVerstoss(t);
  });

  console.log('--- ohne Datenbank: nichts senden, keine Schleife ---');
  await fall('Datenbank weg (jede Anfrage scheitert): keine Meldung, kein Schreiben', async () => {
    const t = tabelle();
    t.stoerung.alles = true;
    assert.equal((await lauf(t, F('W1', 'x'))).gesendet, false);
    assert.equal(t.calls.filter(c => c.m !== 'GET').length, 0);
  });
  await fall('Antwort ohne Liste (JWT expired): keine Meldung, kein Schreiben', async () => {
    const t = tabelle();
    t.stoerung.keineListe = true;
    assert.equal((await lauf(t, F('W1', 'x'))).gesendet, false);
    assert.equal(t.calls.filter(c => c.m !== 'GET').length, 0);
  });
  await fall('Zeile laesst sich nicht anlegen (POST scheitert oder ohne id): keine Meldung', async () => {
    let t = tabelle();
    t.stoerung.post = true;
    assert.equal((await lauf(t, F('W1', 'x'))).gesendet, false);
    t = tabelle();
    t.stoerung.postOhneId = true;
    assert.equal((await lauf(t, F('W1', 'x'))).gesendet, false);
  });
  await fall('zweites Lesen scheitert: keine Meldung, eigene Zeile zurueckgenommen', async () => {
    const t = tabelle();
    t.stoerung.get = (nr) => nr === 2;
    assert.equal((await lauf(t, F('W1', 'x'))).gesendet, false);
    assert.equal(t.rows.length, 0);
    assert.equal(t.calls.filter(c => c.m === 'DELETE').length, 1);
  });
  await fall('Wiederholung, PATCH scheitert: trotzdem keine Meldung', async () => {
    const t = tabelle();
    await lauf(t, F('W1', 'x'));
    t.stoerung.patch = true;
    assert.equal((await lauf(t, F('W1', 'x'))).gesendet, false);
    assert.equal(t.rows.length, 1);
  });

  console.log('--- Telegram scheitert ---');
  await fall('Telegram-Fehler: Zeile telegram fehler, der naechste gleiche Fehler meldet wieder, Deckel nach 3 Versuchen', async () => {
    const t = tabelle();
    const v = [];
    for (let i = 0; i < 4; i++) v.push((await lauf(t, F('W2', 'y'), { error: 'Bad request - please check your parameters' })).gesendet);
    ohneVerstoss(t);
    assert.deepEqual(v, [true, true, true, false]);
    assert.equal(t.rows.filter(x => x.metadata.telegram === 'fehler').length, 3);
    assert.equal(t.rows[2].metadata.ueber_deckel, 1);
  });
  await fall('unbekannte Telegram-Ausgabe (kein ok, kein error): unbekannt, schaltet nicht stumm', async () => {
    const t = tabelle();
    const a = await lauf(t, F('W3', 'z'), {});
    assert.equal(a.log.telegram, 'unbekannt');
    assert.equal(t.rows[0].metadata.telegram, 'unbekannt');
    assert.equal((await lauf(t, F('W3', 'z'))).gesendet, true);
    assert.equal(t.rows[1].metadata.telegram, 'ok');
    assert.equal((await lauf(t, F('W3', 'z'))).gesendet, false);
  });
  await fall('Telegram-Ausgabe nur mit message_id gilt als zugestellt', async () => {
    const t = tabelle();
    const a = await lauf(t, F('W4', 'z'), { message_id: 12 });
    assert.equal(a.log.telegram, 'ok');
  });

  console.log('--- Ausloeserfehler ---');
  await fall('Ausloeserfehler ohne execution: Schluessel aus trigger.error, execution nachgebildet', async () => {
    const t = tabelle();
    const r = await lauf(t, { workflow: { id: 'W5', name: 'W5' }, trigger: { mode: 'trigger', error: { message: 'Activation failed', node: { name: 'Schedule' } } } });
    assert.equal(r.gesendet, true);
    assert.equal(r.item.execution.error.message, 'Activation failed');
    assert.equal(r.item.execution.lastNodeExecuted, 'Schedule');
    assert.equal(r.item.execution.mode, 'trigger');
    assert.match(t.rows[0].content, /Activation failed\. Failed at node "Schedule"/);
    const k2 = (await drosseln({ first: () => ({ json: F('W5', 'Activation failed') }) }, null, tabelle().helpers))[0].json._drossel.schluessel;
    assert.equal(r.item._drossel.schluessel, k2);
  });

  console.log('--- gleichzeitige Fehler (Drossel und Deckel bleiben hart) ---');
  await fall('zwei gleiche Fehler gleichzeitig: 1 Meldung, 1 Zeile, wiederholt 1', async () => {
    const t = tabelle();
    t.verzoegern = true;
    const r = await Promise.all([lauf(t, F('W6', 'gleich')), lauf(t, F('W6', 'gleich'))]);
    ohneVerstoss(t);
    assert.equal(r.filter(x => x.gesendet).length, 1);
    assert.equal(t.rows.length, 1);
    assert.equal(posts(t).length, 2, 'beide hatten reserviert');
    assert.equal(t.calls.filter(c => c.m === 'DELETE').length, 1);
    assert.equal(t.rows[0].metadata.wiederholt, 1);
    assert.equal(t.rows[0].metadata.telegram, 'ok');
  });
  await fall('fuenf verschiedene Fehler gleichzeitig: genau 3 Meldungen, 3 Zeilen', async () => {
    const t = tabelle();
    t.verzoegern = true;
    const r = await Promise.all('abcde'.split('').map(x => lauf(t, F('W7', 'Fehler ' + x))));
    ohneVerstoss(t);
    assert.equal(r.filter(x => x.gesendet).length, 3);
    assert.equal(t.rows.length, 3);
    assert.ok(t.rows.every(z => z.metadata.telegram === 'ok'), JSON.stringify(t.rows.map(z => z.metadata.telegram)));
    assert.equal(t.rows.reduce((s, z) => s + z.metadata.ueber_deckel, 0), 2);
  });
  await fall('gleichzeitig drei gleiche und ein anderer Fehler: beide Fehlerarten gemeldet (Reservierungen fuellen den Deckel nicht)', async () => {
    const t = tabelle();
    t.verzoegern = true;
    const msgs = ['Authorization failed - please check your credentials', 'Authorization failed - please check your credentials',
      'Authorization failed - please check your credentials', 'The resource you are requesting could not be found'];
    const r = await Promise.all(msgs.map(m => lauf(t, F('W12', m))));
    ohneVerstoss(t);
    assert.deepEqual(r.map(x => x.gesendet), [true, false, false, true]);
    assert.equal(t.rows.length, 2);
    assert.ok(t.rows.every(z => z.metadata.telegram === 'ok'), JSON.stringify(t.rows.map(z => z.metadata.telegram)));
    assert.equal(t.rows.reduce((s, z) => s + z.metadata.ueber_deckel, 0), 0);
  });
  await fall('60 gleiche Fehler gleichzeitig: 1 Meldung, 1 Zeile (die aeltesten Zeilen entscheiden, auch ueber 50 hinaus)', async () => {
    const t = tabelle();
    t.verzoegern = true;
    const r = await Promise.all(Array.from({ length: 60 }, () => lauf(t, F('W13', 'viele'))));
    ohneVerstoss(t);
    assert.equal(r.filter(x => x.gesendet).length, 1);
    assert.equal(t.rows.length, 1);
    assert.equal(posts(t).length, 60, 'alle hatten reserviert');
  });

  console.log('--- haengengebliebene Reservierung (nie zugestellt) ---');
  await fall('Reservierung ohne Zustellung: jung stumm, nach zwei Minuten meldet der gleiche Fehler wieder', async () => {
    const t = tabelle();
    // Drosseln laeuft, Telegram und Log nie (Ausfuehrung abgebrochen).
    const a = await drosseln({ first: () => ({ json: F('W10', 'r') }) }, null, t.helpers);
    assert.equal(a.length, 1);
    assert.equal(t.rows[0].metadata.telegram, 'ausstehend');
    assert.equal((await lauf(t, F('W10', 'r'))).gesendet, false, 'junge Reservierung schaltet stumm');
    assert.equal(t.rows.length, 1);
    t.rows[0].created_at = new Date(Date.now() - 3 * 60000).toISOString();
    const r = await lauf(t, F('W10', 'r'));
    ohneVerstoss(t);
    assert.equal(r.gesendet, true, 'drei Minuten alte Reservierung schaltet nicht mehr stumm');
    assert.equal(t.rows.length, 2);
    assert.equal(t.rows[1].metadata.telegram, 'ok');
    assert.equal((await lauf(t, F('W10', 'r'))).gesendet, false, 'die zugestellte Meldung schaltet stumm');
    assert.equal(t.rows[1].metadata.wiederholt, 1);
    // Zum Deckel zaehlt die haengengebliebene Zeile mit: noch eine andere
    // Fehlerart, dann ist er voll.
    assert.equal((await lauf(t, F('W10', 'r2'))).gesendet, true);
    assert.equal((await lauf(t, F('W10', 'r3'))).gesendet, false);
    assert.equal(t.rows.length, 3);
  });
  await fall('Antwort auf das Anlegen kommt zu spaet (Zeile steht, keine Meldung): nach zwei Minuten meldet der gleiche Fehler', async () => {
    const t = tabelle();
    t.stoerung.postAntwortWeg = true;
    assert.equal((await lauf(t, F('W11', 's'))).gesendet, false);
    t.stoerung.postAntwortWeg = false;
    assert.equal(t.rows.length, 1);
    assert.equal(t.rows[0].metadata.telegram, 'ausstehend');
    assert.equal((await lauf(t, F('W11', 's'))).gesendet, false, 'noch jung');
    t.rows[0].created_at = new Date(Date.now() - 3 * 60000).toISOString();
    assert.equal((await lauf(t, F('W11', 's'))).gesendet, true);
    ohneVerstoss(t);
  });
  await fall('Zaehler und Zustellvermerk gleichzeitig an derselben Zeile: beide bleiben', async () => {
    const t = tabelle();
    const aus = await drosseln({ first: () => ({ json: F('W9', 'p') }) }, null, t.helpers);
    t.verzoegern = true;
    const $ = (name) => ({ first: () => { if (name === 'Drosseln') return aus[0]; throw new Error(name); } });
    await Promise.all([loggen({ first: () => ({ json: TG_OK }) }, $, t.helpers), lauf(t, F('W9', 'p')), lauf(t, F('W9', 'p'))]);
    ohneVerstoss(t);
    assert.equal(t.rows.length, 1);
    assert.equal(t.rows[0].metadata.telegram, 'ok');
    assert.equal(t.rows[0].metadata.wiederholt, 2);
  });
  await fall('Log liest vor dem Schreiben frisch: dazwischen gezaehlte Wiederholungen bleiben', async () => {
    const t = tabelle();
    const aus = await drosseln({ first: () => ({ json: F('W8', 'q') }) }, null, t.helpers);
    for (let i = 0; i < 3; i++) await lauf(t, F('W8', 'q'));
    assert.equal(t.rows[0].metadata.wiederholt, 3);
    assert.equal(t.rows[0].metadata.telegram, 'ausstehend');
    const $ = (name) => ({ first: () => { if (name === 'Drosseln') return aus[0]; throw new Error(name); } });
    await loggen({ first: () => ({ json: TG_OK }) }, $, t.helpers);
    assert.equal(t.rows[0].metadata.wiederholt, 3);
    assert.equal(t.rows[0].metadata.telegram, 'ok');
  });
  await fall('Log ohne Zeile von Drosseln: nichts geschrieben', async () => {
    const t = tabelle();
    const $ = () => ({ first: () => ({ json: { workflow: {} } }) });
    const [r] = await loggen({ first: () => ({ json: TG_OK }) }, $, t.helpers);
    assert.equal(r.json.logged, false);
    assert.equal(t.calls.length, 0);
  });

  console.log('\n' + (n - fehler) + ' von ' + n + ' Faellen bestanden');
  process.exit(fehler ? 1 : 0);
})();
