// Prueft den Knoten "Vorbereiten" des Teams-Adapters mit nachgebauten
// PostgREST- und Bruecken-Aufrufen: normale Nachrichten, Installationsmeldung
// (Profil, Zuordnung, Begruessung, Verlaufszeile) und die Abbruchfaelle.
//   node tests/teams-adapter-vorbereiten.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'teams-adapter.json'), 'utf8'));
const code = wf.nodes.find(n => n.name === 'Vorbereiten').parameters.jsCode;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const vorbereiten = new AsyncFunction('$input', code);

const SECRET = '{{BRIDGE_SECRET}}';
const TENANT = '77bb16bd-0000-4000-8000-000000000000';
const OID = '11111111-2222-4333-8444-555555555555';

// Nachgebaute Datenschnittstelle: antwortet je nach URL, merkt sich Schreibzugriffe.
function umgebung(opts = {}) {
  const calls = [];
  const helpers = { httpRequest: async (req) => {
    const url = String(req.url); const m = req.method;
    calls.push({ m, url, body: req.body ? JSON.parse(req.body) : null });
    if (m === 'GET' && url.includes('/user_identity_map?entra_key=eq.')) return opts.map || [];
    if (m === 'GET' && url.includes('/template_credentials?')) return [{ cred_value: TENANT }];
    if (m === 'GET' && url.includes('/user_profiles?user_id=like.web:*')) return opts.web || [];
    if (m === 'GET' && url.includes('/user_identity_map?legacy_key=eq.')) return opts.belegt || [];
    if (m === 'GET' && url.includes('/user_profiles?user_id=eq.')) { if (opts.profilFehler) throw new Error('postgrest down'); return opts.profil || []; }
    if (m === 'GET' && url.includes('/conversations?session_id=eq.')) return opts.verlauf || [];
    if (m === 'POST' && url.endsWith('/reply')) { if (opts.replyFehler) throw new Error('bridge down'); return { ok: true }; }
    return {};
  } };
  return { calls, self: { helpers } };
}
function eingang(body, secret = SECRET) {
  return { first: () => ({ json: { headers: { 'x-bridge-secret': secret }, body } }) };
}
const nachricht = (extra = {}) => Object.assign({ text: 'Wer bin ich?', conversationId: 'a:konv1', serviceUrl: 'https://smba.trafficmanager.net/emea/',
  aadObjectId: OID, fromName: 'Strasser, Sophie', fromId: '29:abc', conversationType: 'personal', tenantId: TENANT }, extra);
const installation = (extra = {}) => Object.assign({ event: 'installiert', text: '', conversationId: 'a:konv1', serviceUrl: 'https://smba.trafficmanager.net/emea/',
  aadObjectId: OID, fromName: 'Strasser, Sophie', givenName: 'Sophie', surname: 'Strasser', upn: 's.strasser@salzburgerland.com',
  fromId: '29:abc', conversationType: 'personal', tenantId: TENANT }, extra);
const nur = (calls, m, teil) => calls.filter(c => c.m === m && c.url.includes(teil));

let n = 0, fehler = 0;
async function fall(name, fn) {
  n++;
  try { await fn(); console.log('PASS', name); }
  catch (e) { fehler++; console.log('FAIL', name, '\n     ', e.message); }
}

(async () => {
  await fall('Nachricht: unbekannte Person -> Entra-Profil, Rupert wird gefragt, kein /reply', async () => {
    const u = umgebung();
    const [r] = await vorbereiten.call(u.self, eingang(nachricht()));
    assert.equal(r.json.abbruch, false);
    assert.equal(r.json.user_id, 'entra:' + OID);
    assert.equal(r.json.message, 'Wer bin ich?');
    assert.equal(r.json.session_id, 'teams:a:konv1');
    const p = nur(u.calls, 'POST', '/user_profiles');
    assert.equal(p.length, 1);
    assert.equal(p[0].body.display_name, 'Sophie Strasser');
    assert.equal(nur(u.calls, 'POST', '/reply').length, 0);
    assert.equal(nur(u.calls, 'GET', '/user_profiles?user_id=eq.').length, 0, 'Bekannt-Pruefung nur bei Installation');
  });

  await fall('Nachricht: Person aus der Map -> Web-Schluessel, kein Profil-Insert', async () => {
    const u = umgebung({ map: [{ legacy_key: 'web:sophie' }] });
    const [r] = await vorbereiten.call(u.self, eingang(nachricht()));
    assert.equal(r.json.abbruch, false);
    assert.equal(r.json.user_id, 'web:sophie');
    assert.equal(nur(u.calls, 'POST', '/user_profiles').length, 0);
  });

  await fall('Nachricht ohne Text bleibt unvollstaendig', async () => {
    const u = umgebung();
    const [r] = await vorbereiten.call(u.self, eingang(nachricht({ text: '' })));
    assert.equal(r.json.abbruch, true);
    assert.equal(r.json.grund, 'unvollstaendige Nutzlast');
  });

  await fall('falsches Geheimnis -> Abbruch, auch bei Installation', async () => {
    const u = umgebung();
    const [r] = await vorbereiten.call(u.self, eingang(installation(), 'falsch'));
    assert.equal(r.json.abbruch, true);
    assert.equal(u.calls.length, 0);
  });

  await fall('Installation: neue Person ohne Web-Profil -> Entra-Profil, Gruss, Verlaufszeile, kein Rupert-Aufruf', async () => {
    const u = umgebung();
    const [r] = await vorbereiten.call(u.self, eingang(installation()));
    assert.equal(r.json.abbruch, true);
    assert.equal(r.json.grund, 'installiert');
    assert.equal(r.json.installiert, true);
    assert.equal(r.json.bekannt, false);
    assert.equal(r.json.begruesst, true);
    assert.equal(r.json.user_id, 'entra:' + OID);
    assert.equal(r.json.display_name, 'Sophie Strasser');
    const p = nur(u.calls, 'POST', '/user_profiles');
    assert.equal(p.length, 1);
    assert.equal(p[0].body.user_id, 'entra:' + OID);
    assert.equal(p[0].body.display_name, 'Sophie Strasser');
    const rep = nur(u.calls, 'POST', '/reply');
    assert.equal(rep.length, 1);
    assert.equal(rep[0].body.conversationId, 'a:konv1');
    assert.equal(rep[0].body.serviceUrl, 'https://smba.trafficmanager.net/emea/');
    assert.match(rep[0].body.text, /^Servus Sophie, ich bin Rupert/);
    assert.ok(rep[0].body.text.length < 600);
    const konv = nur(u.calls, 'POST', '/conversations');
    assert.equal(konv.length, 1);
    assert.equal(konv[0].body.session_id, 'teams:a:konv1');
    assert.equal(konv[0].body.user_id, 'entra:' + OID);
    assert.equal(konv[0].body.role, 'assistant');
    assert.equal(konv[0].body.content, rep[0].body.text);
    assert.ok(!('message' in r.json), 'keine Nachricht an Rupert');
  });

  await fall('Installation: neue Person mit Web-Profil "Sophie Strasser" -> Zuordnung, Gruss unter web:sophie', async () => {
    const u = umgebung({ web: [{ user_id: 'web:sophie', display_name: 'Sophie Strasser' }, { user_id: 'web:freddy', display_name: 'Freddy' }] });
    const [r] = await vorbereiten.call(u.self, eingang(installation()));
    assert.equal(r.json.user_id, 'web:sophie');
    assert.equal(r.json.bekannt, false);
    assert.equal(r.json.begruesst, true);
    const map = nur(u.calls, 'POST', '/user_identity_map');
    assert.equal(map.length, 1);
    assert.equal(map[0].body.legacy_key, 'web:sophie');
    assert.equal(map[0].body.entra_key, 'entra:' + OID);
    assert.equal(nur(u.calls, 'POST', '/user_profiles').length, 0, 'kein Entra-Profil, wenn zugeordnet');
    const konv = nur(u.calls, 'POST', '/conversations');
    assert.equal(konv.length, 1);
    assert.equal(konv[0].body.user_id, 'web:sophie');
  });

  await fall('Installation: bekannte Person (Map-Treffer) -> kein Gruss, keine Verlaufszeile', async () => {
    const u = umgebung({ map: [{ legacy_key: 'web:freddy' }] });
    const [r] = await vorbereiten.call(u.self, eingang(installation({ givenName: 'Freddy', surname: 'Schuetz' })));
    assert.equal(r.json.abbruch, true);
    assert.equal(r.json.grund, 'installiert');
    assert.equal(r.json.bekannt, true);
    assert.equal(r.json.begruesst, false);
    assert.equal(r.json.user_id, 'web:freddy');
    assert.equal(nur(u.calls, 'POST', '/reply').length, 0);
    assert.equal(nur(u.calls, 'POST', '/conversations').length, 0);
  });

  await fall('Installation: bekannte Person (Entra-Profil vorhanden, Neuinstallation) -> kein Gruss', async () => {
    const u = umgebung({ profil: [{ user_id: 'entra:' + OID }] });
    const [r] = await vorbereiten.call(u.self, eingang(installation()));
    assert.equal(r.json.bekannt, true);
    assert.equal(r.json.begruesst, false);
    assert.equal(nur(u.calls, 'POST', '/reply').length, 0);
    assert.equal(nur(u.calls, 'POST', '/conversations').length, 0);
  });

  await fall('Installation: Bruecke nicht erreichbar -> Profil trotzdem da, keine Verlaufszeile, kein Fehler', async () => {
    const u = umgebung({ replyFehler: true });
    const [r] = await vorbereiten.call(u.self, eingang(installation()));
    assert.equal(r.json.abbruch, true);
    assert.equal(r.json.begruesst, false);
    assert.equal(nur(u.calls, 'POST', '/user_profiles').length, 1);
    assert.equal(nur(u.calls, 'POST', '/conversations').length, 0);
  });

  await fall('Installation ohne Vor-/Nachname: Name aus "Nachname, Vorname", Gruss mit Vornamen', async () => {
    const u = umgebung();
    const [r] = await vorbereiten.call(u.self, eingang(installation({ givenName: '', surname: '' })));
    assert.equal(r.json.display_name, 'Sophie Strasser');
    assert.match(nur(u.calls, 'POST', '/reply')[0].body.text, /^Servus Sophie,/);
  });

  await fall('Installation ganz ohne Namen: Gruss ohne Vornamen, Profil wird nicht angelegt', async () => {
    const u = umgebung();
    const [r] = await vorbereiten.call(u.self, eingang(installation({ givenName: '', surname: '', fromName: '' })));
    assert.equal(r.json.abbruch, true);
    assert.match(nur(u.calls, 'POST', '/reply')[0].body.text, /^Servus, ich bin Rupert/);
    assert.equal(nur(u.calls, 'POST', '/user_profiles').length, 0);
  });

  await fall('Installation ohne Objekt-ID -> unvollstaendig, nichts geschrieben', async () => {
    const u = umgebung();
    const [r] = await vorbereiten.call(u.self, eingang(installation({ aadObjectId: '' })));
    assert.equal(r.json.abbruch, true);
    assert.equal(r.json.grund, 'unvollstaendige Nutzlast');
    assert.equal(u.calls.length, 0);
  });

  await fall('Installation aus fremdem Mandanten -> keine Zuordnung zum Web-Profil, Entra-Profil', async () => {
    const u = umgebung({ web: [{ user_id: 'web:sophie', display_name: 'Sophie Strasser' }] });
    const [r] = await vorbereiten.call(u.self, eingang(installation({ tenantId: '00000000-0000-0000-0000-000000000000' })));
    assert.equal(r.json.user_id, 'entra:' + OID);
    assert.equal(nur(u.calls, 'POST', '/user_identity_map').length, 0);
    assert.equal(nur(u.calls, 'POST', '/user_profiles').length, 1);
  });

  await fall('Installation: Web-Profil passt UND Entra-Profil existiert schon -> Zuordnung, aber bekannt, kein Gruss', async () => {
    const u = umgebung({ web: [{ user_id: 'web:sophie', display_name: 'Sophie Strasser' }], profil: [{ user_id: 'entra:' + OID }] });
    const [r] = await vorbereiten.call(u.self, eingang(installation()));
    assert.equal(r.json.user_id, 'web:sophie');
    assert.equal(r.json.bekannt, true);
    assert.equal(r.json.begruesst, false);
    assert.equal(nur(u.calls, 'POST', '/user_identity_map').length, 1);
    assert.equal(nur(u.calls, 'POST', '/reply').length, 0);
    const eq = nur(u.calls, 'GET', '/user_profiles?user_id=eq.');
    assert.equal(eq.length, 1);
    assert.ok(eq[0].url.includes(encodeURIComponent('entra:' + OID)), 'Pruefung gegen den festen Entra-Schluessel');
  });

  await fall('Installation: Verlauf in dieser Konversation vorhanden (ohne Name, ohne Profil) -> bekannt, kein zweiter Gruss', async () => {
    const u = umgebung({ verlauf: [{ id: 1 }] });
    const [r] = await vorbereiten.call(u.self, eingang(installation({ givenName: '', surname: '', fromName: '' })));
    assert.equal(r.json.bekannt, true);
    assert.equal(r.json.begruesst, false);
    assert.equal(nur(u.calls, 'POST', '/reply').length, 0);
    assert.equal(nur(u.calls, 'POST', '/conversations').length, 0);
  });

  await fall('Installation: Profilabfrage schlaegt fehl -> pruefungUnsicher, kein Gruss, Profil trotzdem angelegt', async () => {
    const u = umgebung({ profilFehler: true });
    const [r] = await vorbereiten.call(u.self, eingang(installation()));
    assert.equal(r.json.abbruch, true);
    assert.equal(r.json.pruefungUnsicher, true);
    assert.equal(r.json.begruesst, false);
    assert.equal(nur(u.calls, 'POST', '/reply').length, 0);
    assert.equal(nur(u.calls, 'POST', '/user_profiles').length, 1);
  });

  await fall('Nachricht: Profilabfrage-Fehler aendert nichts am Nachrichtenweg', async () => {
    const u = umgebung({ profilFehler: true });
    const [r] = await vorbereiten.call(u.self, eingang(nachricht()));
    assert.equal(r.json.abbruch, false);
    assert.equal(r.json.user_id, 'entra:' + OID);
    assert.equal(nur(u.calls, 'GET', '/user_profiles?user_id=eq.').length, 0);
  });

  // Knoten "Abbruch melden"
  const abbruchCode = wf.nodes.find(n => n.name === 'Abbruch melden').parameters.jsCode;
  const abbruch = new AsyncFunction('$input', abbruchCode);
  const abbruchEingang = json => ({ first: () => ({ json }) });

  await fall('Abbruch melden: echter Abbruch -> Stopp-Signal an die Bruecke', async () => {
    const u = umgebung();
    const [r] = await abbruch.call(u.self, abbruchEingang({ abbruch: true, grund: 'falsches Geheimnis', conversationId: 'a:konv1' }));
    assert.equal(r.json.abbruch, true);
    assert.equal(r.json.grund, 'falsches Geheimnis');
    const rep = nur(u.calls, 'POST', '/reply');
    assert.equal(rep.length, 1);
    assert.equal(rep[0].body.stop, true);
    assert.equal(rep[0].body.conversationId, 'a:konv1');
  });

  await fall('Abbruch melden: Installation -> kein Stopp-Signal, Felder durchgereicht', async () => {
    const u = umgebung();
    const [r] = await abbruch.call(u.self, abbruchEingang({ abbruch: true, grund: 'installiert', installiert: true, bekannt: false, begruesst: true, pruefungUnsicher: false, user_id: 'web:sophie', display_name: 'Sophie Strasser', conversationId: 'a:konv1' }));
    assert.equal(nur(u.calls, 'POST', '/reply').length, 0);
    assert.equal(r.json.installiert, true);
    assert.equal(r.json.begruesst, true);
    assert.equal(r.json.user_id, 'web:sophie');
    assert.equal(r.json.display_name, 'Sophie Strasser');
  });

  console.log('\n' + (n - fehler) + ' von ' + n + ' Faellen bestanden');
  process.exit(fehler ? 1 : 0);
})();
