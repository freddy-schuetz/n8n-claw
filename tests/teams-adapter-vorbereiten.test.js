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

  // --- Akademische Titel und Sonderzeichen (18.09.2026, Fall Primoz Kompan) ---
  const primoz = (extra = {}) => installation(Object.assign({ fromName: 'Kompan, Mag. Primož', givenName: 'Mag. Primož',
    surname: 'Kompan', upn: 'p.kompan@salzburgerland.com' }, extra));

  await fall('Installation "Kompan, Mag. Primoz" trifft das Web-Profil "Primoz Kompan"', async () => {
    const u = umgebung({ web: [{ user_id: 'web:primoz', display_name: 'Primoz Kompan' }, { user_id: 'web:freddy', display_name: 'Freddy Schuetz' }] });
    const [r] = await vorbereiten.call(u.self, eingang(primoz()));
    assert.equal(r.json.user_id, 'web:primoz', 'Titel und Hatschek duerfen die Zuordnung nicht verhindern');
    const map = nur(u.calls, 'POST', '/user_identity_map');
    assert.equal(map.length, 1);
    assert.equal(map[0].body.legacy_key, 'web:primoz');
    assert.equal(nur(u.calls, 'POST', '/user_profiles').length, 0, 'kein zweites Entra-Profil');
  });

  await fall('Anzeigename und Gruss ohne Titel', async () => {
    const u = umgebung();
    const [r] = await vorbereiten.call(u.self, eingang(primoz()));
    assert.equal(r.json.display_name, 'Primož Kompan');
    assert.equal(nur(u.calls, 'POST', '/user_profiles')[0].body.display_name, 'Primož Kompan');
    assert.match(nur(u.calls, 'POST', '/reply')[0].body.text, /^Servus Primož,/);
  });

  await fall('Teams mit Hatschek trifft Web-Profil mit Hatschek ebenfalls', async () => {
    const u = umgebung({ web: [{ user_id: 'web:primoz', display_name: 'Primož Kompan' }] });
    const [r] = await vorbereiten.call(u.self, eingang(primoz()));
    assert.equal(r.json.user_id, 'web:primoz');
  });

  await fall('Mehrere Titel (DI Dr.) werden gestrichen', async () => {
    const u = umgebung({ web: [{ user_id: 'web:test', display_name: 'Anna Berger' }] });
    const [r] = await vorbereiten.call(u.self, eingang(installation({ fromName: 'Berger, DI Dr. Anna', givenName: 'DI Dr. Anna', surname: 'Berger' })));
    assert.equal(r.json.user_id, 'web:test');
    assert.equal(r.json.display_name, 'Anna Berger');
  });

  await fall('Name, der nur aus einem Titelwort plus Namen besteht, schrumpft nicht auf ein Wort', async () => {
    const u = umgebung({ web: [{ user_id: 'web:dimarco', display_name: 'Di Marco' }] });
    const [r] = await vorbereiten.call(u.self, eingang(installation({ fromName: 'Di Marco', givenName: 'Di', surname: 'Marco' })));
    assert.equal(r.json.display_name, 'Di Marco', 'ungekuerzt, weil sonst nur ein Wort bliebe');
  });

  await fall('Regression: Name ohne Titel unveraendert', async () => {
    const u = umgebung({ web: [{ user_id: 'web:sophie', display_name: 'Sophie Strasser' }] });
    const [r] = await vorbereiten.call(u.self, eingang(installation()));
    assert.equal(r.json.user_id, 'web:sophie');
    assert.equal(r.json.display_name, 'Sophie Strasser');
  });

  await fall('Regression: Schnoell mit Umlaut trifft das Web-Profil mit ue', async () => {
    const u = umgebung({ web: [{ user_id: 'web:michael', display_name: 'Michael Schnoell' }] });
    const [r] = await vorbereiten.call(u.self, eingang(installation({ fromName: 'Schnöll, Michael', givenName: 'Michael', surname: 'Schnöll' })));
    assert.equal(r.json.user_id, 'web:michael');
  });

  // --- Titel im Nachnamen (19.10.2026): Entra fuehrt sie bei SLT als "Hochreiter, MA".
  // Daraus wurden "MA Victoria Hochreiter", "BA Matthias Berger", "(FH) Waltraud
  // Paradeiser", "Alina Leitner," und "Leo Bauernberger,". ---
  for (const [vor, nach, soll] of [
    ['Victoria', 'Hochreiter, MA', 'Victoria Hochreiter'],
    ['Matthias', 'Berger, BA', 'Matthias Berger'],
    ['Waltraud', 'Paradeiser, Mag. (FH)', 'Waltraud Paradeiser'],
    ['Alina', 'Leitner, BSc', 'Alina Leitner'],
    ['Leo', 'Bauernberger, MSc', 'Leo Bauernberger'],
    ['Eva', 'Haselsteiner, M.A.', 'Eva Haselsteiner'],
    ['Thomas', 'Tax, LL.B.', 'Thomas Tax']
  ]) {
    await fall('Installation "' + vor + ' ' + nach + '" -> Profil "' + soll + '", Gruss mit Vornamen', async () => {
      const u = umgebung();
      const [r] = await vorbereiten.call(u.self, eingang(installation({ fromName: nach.split(',')[0] + ', ' + vor, givenName: vor, surname: nach })));
      assert.equal(r.json.display_name, soll);
      const p = nur(u.calls, 'POST', '/user_profiles');
      assert.equal(p[0].body.display_name, soll);
      assert.equal(p[0].body.name, soll);
      assert.match(nur(u.calls, 'POST', '/reply')[0].body.text, new RegExp('^Servus ' + vor + ','));
    });
  }

  await fall('Nachricht "Hochreiter, MA Victoria" -> Victoria Hochreiter, trifft das Web-Profil', async () => {
    const u = umgebung({ web: [{ user_id: 'web:victoria', display_name: 'Victoria Hochreiter' }] });
    const [r] = await vorbereiten.call(u.self, eingang(nachricht({ fromName: 'Hochreiter, MA Victoria' })));
    assert.equal(r.json.user_id, 'web:victoria');
  });

  await fall('Nachricht "Leitner, Alina" bleibt "Alina Leitner" (Tausch wie bisher)', async () => {
    const u = umgebung();
    await vorbereiten.call(u.self, eingang(nachricht({ fromName: 'Leitner, Alina' })));
    assert.equal(nur(u.calls, 'POST', '/user_profiles')[0].body.display_name, 'Alina Leitner');
  });

  await fall('Nachname "Ma" (kein Titel) bleibt, weil sonst nur ein Wort uebrig waere', async () => {
    const u = umgebung();
    const [r] = await vorbereiten.call(u.self, eingang(installation({ fromName: 'Ma, Long', givenName: 'Long', surname: 'Ma' })));
    assert.equal(r.json.display_name, 'Long Ma');
  });

  // --- Runde 10b (Review 19.10.2026): Kurzformen nur in Titelschreibweise ---
  await fall('Web "Xiao Ling Ma" darf NICHT an "Xiao Ling Wang" gebunden werden (Identitaet!)', async () => {
    const u = umgebung({ web: [{ user_id: 'web:xlma', display_name: 'Xiao Ling Ma' }] });
    const [r] = await vorbereiten.call(u.self, eingang(installation({ fromName: 'Wang, Xiao Ling', givenName: 'Xiao Ling', surname: 'Wang' })));
    assert.equal(r.json.user_id, 'entra:' + OID);
    assert.equal(nur(u.calls, 'POST', '/user_identity_map').length, 0);
  });
  await fall('Nachricht "Wang, Xiao Ling" bindet ebenfalls nicht an "Xiao Ling Ma"', async () => {
    const u = umgebung({ web: [{ user_id: 'web:xlma', display_name: 'Xiao Ling Ma' }] });
    const [r] = await vorbereiten.call(u.self, eingang(nachricht({ fromName: 'Wang, Xiao Ling' })));
    assert.equal(r.json.user_id, 'entra:' + OID);
    assert.equal(nur(u.calls, 'POST', '/user_identity_map').length, 0);
  });
  await fall('Web "Maria Mas Puig" bindet nicht an "Puig, Maria Elena"', async () => {
    const u = umgebung({ web: [{ user_id: 'web:mmp', display_name: 'Maria Mas Puig' }] });
    const [r] = await vorbereiten.call(u.self, eingang(nachricht({ fromName: 'Puig, Maria Elena' })));
    assert.equal(r.json.user_id, 'entra:' + OID);
  });
  // Dritte Gegenlese: ein Web-Name mit Kurzform wird nie nach dem Namen zugeordnet,
  // auch wenn es dieselbe Person waere (sie verbindet sich ueber Microsoft).
  await fall('Web "Long Ma" und "Ma, Long Wei": nicht nach dem Namen zugeordnet (Kurzform im Web-Namen)', async () => {
    const u = umgebung({ web: [{ user_id: 'web:longma', display_name: 'Long Ma' }] });
    const [r] = await vorbereiten.call(u.self, eingang(nachricht({ fromName: 'Ma, Long Wei' })));
    assert.equal(r.json.user_id, 'entra:' + OID);
    assert.equal(nur(u.calls, 'POST', '/user_identity_map').length, 0);
  });
  for (const [vor, nach, soll, gruss] of [
    ['Xiao Ling', 'Ma', 'Xiao Ling Ma', 'Xiao Ling'],
    ['Mamadou Lamine', 'Ba', 'Mamadou Lamine Ba', 'Mamadou Lamine'],
    ['Maria', 'Mas Puig', 'Maria Mas Puig', 'Maria'],
    ['Van Ba', 'Nguyen', 'Van Ba Nguyen', 'Van Ba'],
    ['Long', 'Ma, MSc', 'Long Ma', 'Long'],
    ['Anna', 'Huber, M.Sc.', 'Anna Huber', 'Anna'],
    ['Anna', 'Huber, B.Ed.', 'Anna Huber', 'Anna'],
    ['Anna', 'Huber, Mag. phil.', 'Anna Huber', 'Anna'],
    ['Anna', 'Huber, Dr. rer. nat.', 'Anna Huber', 'Anna'],
    ['Phil', 'Collins', 'Phil Collins', 'Phil'],
    ['Luca', 'di Marco', 'Luca di Marco', 'Luca']
  ]) {
    await fall('Installation "' + vor + '" / "' + nach + '" -> "' + soll + '"', async () => {
      const u = umgebung();
      const [r] = await vorbereiten.call(u.self, eingang(installation({ fromName: nach + ', ' + vor, givenName: vor, surname: nach })));
      assert.equal(r.json.display_name, soll);
      assert.match(nur(u.calls, 'POST', '/reply')[0].body.text, new RegExp('^Servus ' + gruss + ','));
    });
  }
  // --- Zweite Gegenlese 19.10.2026: Kontext fuer Kurzformen, Web-Seite nur eindeutig ---
  // Dritte Gegenlese: Web-Namen mit Kurzform (Di Marco, Ma, Mas Puig) werden nicht
  // mehr nach dem Namen zugeordnet. Ob "MA" in Teams Titel oder Name ist, laesst sich
  // nicht sicher sagen; ein Fehlgriff gaebe einer fremden Person die Identitaet.
  for (const [web, teams, soll] of [
    ['Luca Di Marco', { nachricht: 'DI MARCO, Luca' }, null],
    ['Luca Di Marco', { nachricht: 'Luca DI MARCO' }, null],
    ['Luca Di Marco', { installation: ['Luca', 'DI MARCO'] }, null],
    ['Xiao Ling Ma', { nachricht: 'MA, Xiao Ling' }, null],
    ['Maria Mas Puig', { nachricht: 'MAS PUIG, Maria' }, null],
    ['Jean Pierre Mba', { nachricht: 'Obame, Jean Pierre' }, null],
    ['Med Amine Trabelsi', { nachricht: 'Trabelsi, Amine' }, null],
    ['Anna Maria Ing', { nachricht: 'Huber, Anna Maria' }, null],
    ['Xiao Ling MA', { nachricht: 'Wang, Xiao Ling' }, null],
    ['Victoria Hochreiter', { nachricht: 'Hochreiter, MA Victoria' }, 'web:ldm'],
    ['Victoria Hochreiter', { installation: ['Victoria', 'Hochreiter, MA'] }, 'web:ldm'],
    // dritte Gegenlese: fremde Person mit Titel neben einem gross geschriebenen Wort
    ['Anna Ma', { nachricht: 'Huber, Anna, MA MPA' }, null],
    ['Anna Ma', { nachricht: 'Huber, MA MPA Anna' }, null],
    ['Anna Ma', { nachricht: 'Anna Huber MA MPA' }, null],
    ['Anna Ma', { nachricht: 'HUBER, MA Anna' }, null],
    ['Anna Ma', { nachricht: 'HUBER MA, Anna' }, null],
    ['Anna Ma', { installation: ['Anna', 'Huber, MA MPA'] }, null],
    ['Lea Ba', { nachricht: 'Steurer BA, LEA' }, null],
    ['Anna Ba', { nachricht: 'Huber, BA MPH Anna' }, null],
    // Kurztitel im Web-Namen: wie oben nicht nach dem Namen (Web-Namen ohne Titel anlegen)
    ['Victoria Hochreiter MA', { nachricht: 'Hochreiter, MA Victoria' }, null],
    ['Waltraud Paradeiser', { nachricht: 'Paradeiser, Mag. (FH) Waltraud' }, 'web:ldm'],
    ['Anna Huber', { nachricht: 'Huber, Anna, MA MPA' }, 'web:ldm']
  ]) {
    const was = teams.nachricht ? 'Nachricht "' + teams.nachricht + '"' : 'Installation "' + teams.installation.join('" / "') + '"';
    await fall('Web "' + web + '" und ' + was + ': ' + (soll ? 'zugeordnet' : 'NICHT zugeordnet'), async () => {
      const u = umgebung({ web: [{ user_id: 'web:ldm', display_name: web }] });
      const eing = teams.nachricht ? nachricht({ fromName: teams.nachricht })
        : installation({ fromName: teams.installation[1] + ', ' + teams.installation[0], givenName: teams.installation[0], surname: teams.installation[1] });
      const [r] = await vorbereiten.call(u.self, eingang(eing));
      assert.equal(r.json.user_id, soll || ('entra:' + OID));
      assert.equal(nur(u.calls, 'POST', '/user_identity_map').length, soll ? 1 : 0);
    });
  }
  for (const [vor, nach, soll, gruss] of [
    ['Waltraud', 'Paradeiser, Mag. (fh)', 'Waltraud Paradeiser', 'Waltraud'],
    ['Anna', 'Huber, m.a.', 'Anna Huber', 'Anna'],
    ['Anna', 'Huber, BED', 'Anna Huber', 'Anna'],
    ['Anna', 'Huber, Mag. pharm.', 'Anna Huber', 'Anna'],
    ['Anna', 'Huber, Ph.D.', 'Anna Huber', 'Anna'],
    ['Anna', 'Huber, BBA', 'Anna Huber', 'Anna'],
    ['DIin Anna', 'Huber', 'Anna Huber', 'Anna'],
    ['Univ.-Prof. Dr. Anna', 'Huber', 'Anna Huber', 'Anna'],
    ['Dr. h.c. Anna', 'Huber', 'Anna Huber', 'Anna'],
    ['Ing. Anna', 'Huber', 'Anna Huber', 'Anna'],
    ['Art', 'Garfunkel', 'Art Garfunkel', 'Art'],
    ['Ing', 'Bergmann', 'Ing Bergmann', 'Ing']
  ]) {
    await fall('Installation "' + vor + '" / "' + nach + '" -> "' + soll + '", Gruss "' + gruss + '"', async () => {
      const u = umgebung();
      const [r] = await vorbereiten.call(u.self, eingang(installation({ fromName: nach + ', ' + vor, givenName: vor, surname: nach })));
      assert.equal(r.json.display_name, soll);
      assert.match(nur(u.calls, 'POST', '/reply')[0].body.text, new RegExp('^Servus ' + gruss + ','));
    });
  }

  for (const [von, soll] of [
    ['Hochreiter MA, Victoria', 'Victoria Hochreiter'],
    ['Berger BA, Matthias', 'Matthias Berger'],
    ['Paradeiser Mag. (FH), Waltraud', 'Waltraud Paradeiser'],
    ['Ma, Xiao Ling', 'Xiao Ling Ma'],
    ['Ba, Mag. Amadou', 'Amadou Ba'],
    ['Ma, Dr. Long', 'Long Ma'],
    ['Huber, Anna, MA MPA', 'Anna Huber'],
    ['Huber, Anna, MBA MPH', 'Anna Huber'],
    // vierte Gegenlese: ein Nachbar jenseits des Kommas macht MA nicht zum Namen
    ['HOCHREITER, MA Victoria', 'Victoria HOCHREITER'],
    ['BERGER, BA Anna', 'Anna BERGER'],
    ['DI MARCO, Luca', 'Luca DI MARCO'],
    ['MAS PUIG, Maria', 'Maria MAS PUIG'],
    ['Luca DI MARCO', 'Luca DI MARCO']
  ]) {
    await fall('Nachricht "' + von + '" -> Profil "' + soll + '"', async () => {
      const u = umgebung();
      await vorbereiten.call(u.self, eingang(nachricht({ fromName: von })));
      assert.equal(nur(u.calls, 'POST', '/user_profiles')[0].body.display_name, soll);
    });
  }

  // Vierte Gegenlese: ein Kurzform-Profil zaehlt weiter als Treffer und sperrt so
  // eine mehrdeutige Zuordnung; zugeordnet wird es selbst nie.
  for (const [web, von] of [
    [[{ user_id: 'web:mmp', display_name: 'Maria Mas Puig' }, { user_id: 'web:ep', display_name: 'Elena Puig' }], 'Mas Puig, Maria Elena'],
    [[{ user_id: 'web:mmp', display_name: 'Maria Mas Puig' }, { user_id: 'web:ep', display_name: 'Elena Puig' }], 'MAS PUIG, Maria Elena'],
    [[{ user_id: 'web:ldm', display_name: 'Luca Di Marco' }, { user_id: 'web:pm', display_name: 'Paolo Marco' }], 'Di Marco, Luca Paolo'],
    [[{ user_id: 'web:mmp', display_name: 'Maria Mas Puig' }], 'Mas Puig, Maria Elena']
  ]) {
    await fall('Web ' + web.map(p => '"' + p.display_name + '"').join(' + ') + ', Nachricht "' + von + '": niemand zugeordnet', async () => {
      const u = umgebung({ web });
      const [r] = await vorbereiten.call(u.self, eingang(nachricht({ fromName: von })));
      assert.equal(r.json.user_id, 'entra:' + OID);
      assert.equal(nur(u.calls, 'POST', '/user_identity_map').length, 0);
    });
  }
  await fall('Installation ohne Vor- und Nachname, "HOCHREITER, MA Victoria": Gruss "Servus Victoria"', async () => {
    const u = umgebung();
    const [r] = await vorbereiten.call(u.self, eingang(installation({ fromName: 'HOCHREITER, MA Victoria', givenName: '', surname: '' })));
    assert.equal(r.json.display_name, 'Victoria HOCHREITER');
    assert.match(nur(u.calls, 'POST', '/reply')[0].body.text, /^Servus Victoria,/);
  });

  await fall('Web "Sophie Strasser" und "Sophie Ma", Nachricht "Strasser, Sophie, MA MPA": eindeutig web:sophie', async () => {
    const u = umgebung({ web: [{ user_id: 'web:sophie', display_name: 'Sophie Strasser' }, { user_id: 'web:sma', display_name: 'Sophie Ma' }] });
    const [r] = await vorbereiten.call(u.self, eingang(nachricht({ fromName: 'Strasser, Sophie, MA MPA' })));
    assert.equal(r.json.user_id, 'web:sophie');
    const map = nur(u.calls, 'POST', '/user_identity_map');
    assert.equal(map.length, 1);
    assert.equal(map[0].body.legacy_key, 'web:sophie');
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
