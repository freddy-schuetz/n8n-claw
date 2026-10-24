// Runde 11b (B3): Tagesprotokoll ohne Ruperts Antwort nach Laeufen mit
// persoenlicher Quelle (Postfach, Kalender, SharePoint, Transkript, Teams-Bote),
// auch wenn der Expertenagent sie benutzt hat; die Konsolidierung nimmt aus
// Zeilen ohne Pruefvermerk nur die Nachricht der Person. Der ECHTE Code aus
// ../workflows laeuft gegen nachgebaute Schnittstellen.
//   node tests/b3-tagesprotokoll.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const agent = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'n8n-claw-agent.json'), 'utf8'));
const kons = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'memory-consolidation.json'), 'utf8'));
function code(wf, name) {
  return wf.nodes.find(n => n.name === name).parameters.jsCode
    .replace(/\{\{SUPABASE_URL\}\}/g, 'http://stub.local')
    .replace(/\{\{SUPABASE_SERVICE_KEY\}\}/g, 'stub-key');
}
const speichern = new AsyncFunction('$input', '$', 'helpers', '$execution', code(agent, 'Save Conversation and Log'));
const speichernOhneExec = new AsyncFunction('$input', '$', 'helpers', code(agent, 'Save Conversation and Log'));

const BSP = { userMessage: 'Fasse die Mail von X zusammen', sessionId: 'teams:a:k1', userId: 'entra:abc', qualifiedUserId: 'entra:abc', source: 'teams', _webhookSource: true, metadata: { display_name: 'Test Person' } };
const ANTWORT = 'Die Mail sagt: GEHEIMINHALT';

// audit: Antwort auf die Abfrage je Ausfuehrung; unter: Antwort auf die Abfrage
// der Aufrufe des Expertenagenten (origin sub-agent). Ein Error wird geworfen.
function umgebung(audit, unter = []) {
  const calls = [];
  const helpers = { httpRequest: async (req) => {
    calls.push({ m: req.method, url: String(req.url), headers: req.headers || {}, body: req.body ? JSON.parse(req.body) : null, timeout: req.timeout });
    if (req.method === 'GET' && String(req.url).includes('/tool_audit_log')) {
      const a = String(req.url).includes('origin=eq.sub-agent') ? unter : audit;
      if (a instanceof Error) throw a;
      return a;
    }
    return {};
  } };
  const $ = (name) => ({ first: () => {
    if (name === 'Build System Prompt') return { json: BSP };
    if (name === 'Abbruch-Antwort') return { json: { output: ANTWORT, _fallback: false } };
    if (name === 'Load User Profile') return { json: { setup_done: true } };
    throw new Error('unbekannter Knoten: ' + name);
  } });
  return { calls, $, helpers };
}
const nur = (calls, m, teil) => calls.filter(c => c.m === m && c.url.includes(teil));

let n = 0, fehler = 0;
async function fall(name, fn) {
  n++;
  try { await fn(); console.log('PASS', name); }
  catch (e) { fehler++; console.log('FAIL', name, '\n     ', e.message); }
}

async function lauf(audit, { unter = [], mitExec = true } = {}) {
  const u = umgebung(audit, unter);
  if (mitExec) await speichern({ first: () => ({ json: {} }) }, u.$, u.helpers, { id: '4711' });
  else await speichernOhneExec({ first: () => ({ json: {} }) }, u.$, u.helpers);
  const daily = nur(u.calls, 'POST', '/memory_daily');
  assert.equal(daily.length, 1, 'genau ein memory_daily-POST');
  const konv = nur(u.calls, 'POST', '/conversations');
  assert.equal(konv.length, 2);
  assert.equal(konv[1].body.content, ANTWORT, 'Verlauf bleibt vollstaendig');
  return { u, d: daily[0].body };
}
const MAIL = [{ server_url: 'https://agent.sltg.at/mcp/microsoft-mail', tool_name: 'search_messages' }];

(async () => {
  console.log('--- Save Conversation and Log ---');
  await fall('Postfach-Lauf: nur die Nachricht der Person, Vermerk gesetzt, Abfrage je Ausfuehrung mit Service-Schluessel', async () => {
    const { u, d } = await lauf(MAIL);
    assert.equal(d.content, BSP.userMessage + ' → [Antwort ausgelassen]');
    assert.ok(!d.content.includes('GEHEIMINHALT'));
    assert.deepEqual(d.metadata, { quellen_geprueft: true, persoenliche_quelle: true, experte: false, werkzeuge: ['microsoft-mail/search_messages'] });
    const get = nur(u.calls, 'GET', '/tool_audit_log')[0];
    assert.match(get.url, /\/rest\/v1\/tool_audit_log\?execution_id=eq\.4711&select=server_url,tool_name&limit=1000$/);
    assert.equal(get.headers.Authorization, 'Bearer stub-key');
    assert.equal(get.headers.apikey, 'stub-key');
    assert.equal(get.timeout, 4000);
  });
  for (const s of ['microsoft-calendar/find_free_slots', 'microsoft-sharepoint/read_file', 'vexa-meetings/get_transcript', 'teams-messages/send_teams_message']) {
    await fall('persoenliche Quelle ' + s + ': Antwort ausgelassen', async () => {
      const [srv, tool] = s.split('/');
      const { d } = await lauf([{ server_url: 'https://agent.sltg.at/mcp/' + srv, tool_name: tool }, { server_url: 'https://agent.sltg.at/mcp/confluence', tool_name: 'get_page' }]);
      assert.equal(d.content, BSP.userMessage + ' → [Antwort ausgelassen]');
      assert.equal(d.metadata.persoenliche_quelle, true);
    });
  }
  await fall('Adresse ohne Host (vom Modell so geschickt) zaehlt ebenso', async () => {
    const { d } = await lauf([{ server_url: 'microsoft-calendar', tool_name: 'list_events' }]);
    assert.equal(d.metadata.persoenliche_quelle, true);
  });
  await fall('nur Confluence und Jira: Antwort bleibt im Tagesprotokoll', async () => {
    const { d } = await lauf([{ server_url: 'https://agent.sltg.at/mcp/confluence', tool_name: 'get_page' }, { server_url: 'https://agent.sltg.at/mcp/jira', tool_name: 'get_issue' }]);
    assert.equal(d.content, BSP.userMessage + ' → ' + ANTWORT);
    assert.equal(d.metadata.persoenliche_quelle, false);
    assert.deepEqual(d.metadata.werkzeuge, ['confluence/get_page', 'jira/get_issue']);
  });
  await fall('kein Werkzeug: Antwort bleibt, leere Liste', async () => {
    const { d } = await lauf([]);
    assert.equal(d.content, BSP.userMessage + ' → ' + ANTWORT);
    assert.deepEqual(d.metadata, { quellen_geprueft: true, persoenliche_quelle: false, experte: false, werkzeuge: [] });
  });
  await fall('Expertenagent las ein Transkript (origin sub-agent, eigene Ausfuehrung): Antwort ausgelassen', async () => {
    const { u, d } = await lauf([], { unter: [{ server_url: 'https://agent.sltg.at/mcp/vexa-meetings', tool_name: 'get_transcript' }] });
    assert.equal(d.content, BSP.userMessage + ' → [Antwort ausgelassen]');
    assert.equal(d.metadata.persoenliche_quelle, true);
    assert.equal(d.metadata.experte, true);
    assert.deepEqual(d.metadata.werkzeuge, [], 'Werkzeugliste nur aus diesem Lauf');
    const get = nur(u.calls, 'GET', 'origin=eq.sub-agent')[0];
    const m = get.url.match(/\/rest\/v1\/tool_audit_log\?origin=eq\.sub-agent&created_at=gte\.([^&]+)&select=server_url,tool_name&limit=1000$/);
    assert.ok(m, get.url);
    const seit = new Date(decodeURIComponent(m[1])).getTime();
    const vor = (Date.now() - seit) / 60000;
    assert.ok(vor > 14.5 && vor < 15.5, 'Fenster 15 Minuten, war ' + vor);
    assert.equal(get.headers.Authorization, 'Bearer stub-key');
  });
  await fall('Expertenagent nur mit Websuche oder Confluence: Antwort bleibt', async () => {
    const { d } = await lauf([], { unter: [{ server_url: 'https://agent.sltg.at/mcp/confluence', tool_name: 'search_pages' }] });
    assert.equal(d.content, BSP.userMessage + ' → ' + ANTWORT);
    assert.equal(d.metadata.experte, false);
  });
  await fall('Abfrage des Expertenagenten nicht lesbar (wirft): gilt als persoenlich', async () => {
    const { d } = await lauf([], { unter: new Error('ETIMEDOUT') });
    assert.equal(d.content, BSP.userMessage + ' → [Antwort ausgelassen]');
    assert.equal(d.metadata.persoenliche_quelle, true);
  });
  await fall('Abfrage des Expertenagenten liefert keine Liste: gilt als persoenlich', async () => {
    const { d } = await lauf([], { unter: { code: 'PGRST002' } });
    assert.equal(d.metadata.persoenliche_quelle, true);
  });
  await fall('Protokoll nicht lesbar (wirft): gilt als persoenlich', async () => {
    const { d } = await lauf(new Error('ETIMEDOUT'));
    assert.equal(d.content, BSP.userMessage + ' → [Antwort ausgelassen]');
    assert.equal(d.metadata.persoenliche_quelle, true);
  });
  await fall('Protokoll liefert keine Liste: gilt als persoenlich', async () => {
    const { d } = await lauf({ code: 'PGRST002' });
    assert.equal(d.metadata.persoenliche_quelle, true);
  });
  await fall('ohne $execution: keine Abfrage, gilt als persoenlich', async () => {
    const { u, d } = await lauf([], { mitExec: false });
    assert.equal(nur(u.calls, 'GET', '/tool_audit_log').length, 0);
    assert.equal(d.metadata.persoenliche_quelle, true);
  });

  console.log('--- Consolidate Memory ---');
  const KCODE = code(kons, 'Consolidate Memory');
  const zeilen = [
    { id: 11, date: '2026-10-20', user_id: 'web:hannah', role: 'interaction', created_at: '2026-10-20T08:00:00Z', metadata: { quellen_geprueft: true, persoenliche_quelle: false, werkzeuge: [] }, content: 'Wie heisst das Projekt? → Das Projekt heisst SICHTBAR_GEPRUEFT und ist ein Arbeitsthema mit genug Text.' },
    { id: 12, date: '2026-10-20', user_id: 'web:hannah', role: 'interaction', created_at: '2026-10-20T08:05:00Z', metadata: {}, content: 'Was steht in der Mail von Y? → Die Mail sagt ALTGEHEIM, und noch mehr Text dazu.' },
    { id: 13, date: '2026-10-20', user_id: 'web:hannah', role: 'interaction', created_at: '2026-10-20T08:06:00Z', content: 'Zeile ganz ohne Pfeil und ohne metadata, lang genug fuer den Tag.' },
    { id: 14, date: '2026-10-20', user_id: 'web:hannah', role: 'interaction', created_at: '2026-10-20T08:07:00Z', metadata: { quellen_geprueft: true, persoenliche_quelle: true, werkzeuge: ['microsoft-mail/get_message'] }, content: 'Lies die Mail von Z → [Antwort ausgelassen]' },
    { id: 15, date: '2026-10-20', user_id: 'web:hannah', role: 'interaction', created_at: '2026-10-20T08:08:00Z', metadata: { quellen_geprueft: 'ja' }, content: 'Vermerk ohne true → Antwort ZWEIFELHAFT darf nicht hinein.' }
  ];
  const st = { llm: [], gespeichert: [] };
  const helpers = { async httpRequest(o) {
    const url = String(o.url || '');
    const voll = (body, statusCode = 200) => (o.returnFullResponse ? { statusCode, body } : body);
    if (url.startsWith('https://api.anthropic.com')) {
      st.llm.push(o.body);
      if (/Extract from this text/.test(o.body.system || '')) return voll({ content: [{ type: 'text', text: '{"tags":[],"entities":[]}' }], stop_reason: 'end_turn' });
      return voll({ content: [{ type: 'text', text: 'Arbeitswissen zum Projekt.' }], stop_reason: 'end_turn' });
    }
    if (o.method === 'DELETE') return voll('');
    if (url.includes('/heartbeat_config?check_name=eq.memory_consolidation')) return voll([{ config: { last_id: 10, insights: false } }]);
    if (url.includes('/heartbeat_config?on_conflict=check_name')) return voll('', 201);
    if (url.includes('/memory_daily?id=gt.')) return voll(zeilen);
    if (url.includes('/user_profiles?user_id=in.(')) return voll([{ user_id: 'web:hannah', display_name: 'Hannah Traussnigg' }]);
    if (url.includes('/tools_config?tool_name=eq.llm_provider')) return voll([{ enabled: true, config: { provider: 'anthropic', model: 'claude-sonnet-5', api_key: 'x' } }]);
    if (url.includes('/tools_config?tool_name=eq.embedding')) return voll([]);
    if (url.includes('/memory_long?category=eq.consolidated&metadata-%3E%3Edate=eq.')) return voll([]);
    if (o.method === 'POST' && url.endsWith('/rest/v1/memory_long')) { st.gespeichert.push(o.body); return voll('', 201); }
    throw new Error('unerwarteter Aufruf ' + o.method + ' ' + url);
  } };
  const fn = new AsyncFunction('$input', 'helpers', KCODE);
  let out = null, threw = null;
  try { out = (await fn.call({ helpers }, { all: () => [] }, helpers))[0].json; } catch (e) { threw = e; }
  const zus = st.llm.find(b => /Gesprächsprotokoll/.test(b.system || '')) || { messages: [{ content: '' }], system: '' };
  const prot = zus.messages[0].content;
  await fall('Lauf ohne Fehler, ein Eintrag gespeichert', async () => {
    assert.equal(threw, null, threw && threw.message);
    assert.equal(st.gespeichert.length, 1);
    assert.equal(out.status, 'completed');
  });
  await fall('gepruefte Zeile ohne persoenliche Quelle: Antwort im Protokoll', async () => {
    assert.match(prot, /SICHTBAR_GEPRUEFT/);
  });
  await fall('alte Zeile ohne Vermerk: nur die Nachricht, Antwort nicht im Protokoll', async () => {
    assert.ok(!prot.includes('ALTGEHEIM'), prot);
    assert.match(prot, /- Was steht in der Mail von Y\? → \[Antwort ausgelassen\]/);
  });
  await fall('alte Zeile ohne Pfeil: ganzer Text als Nachricht, Vermerk dahinter', async () => {
    assert.match(prot, /- Zeile ganz ohne Pfeil und ohne metadata, lang genug fuer den Tag\. → \[Antwort ausgelassen\]/);
  });
  await fall('Vermerk nicht genau true: wie ungeprueft, Antwort draussen', async () => {
    assert.ok(!prot.includes('ZWEIFELHAFT'), prot);
  });
  await fall('gepruefte Zeile mit persoenlicher Quelle bleibt wie geschrieben (kein doppelter Vermerk)', async () => {
    assert.match(prot, /- Lies die Mail von Z → \[Antwort ausgelassen\]\n?/);
    assert.ok(!/\[Antwort ausgelassen\] → \[Antwort ausgelassen\]/.test(prot));
  });
  await fall('Auftrag erklaert den Vermerk, ohne technische Probleme und ohne Vermutungen, Abwesenheit ohne Grund', async () => {
    const sys = zus.system;
    assert.match(sys, /Steht statt der Antwort \[Antwort ausgelassen\]/);
    assert.ok(!/wiederkehrende technische Probleme/.test(sys));
    assert.match(sys, /Technische Probleme, Fehlermeldungen und Störungen/);
    assert.match(sys, /Vermutungen und Erklärungsversuche von Rupert/);
    assert.match(sys, /auch, wenn die Person es selbst sagt oder es in einem Transkript steht/);
    assert.ok(![...sys].some(z => [0x2013, 0x2014, 0xFFFD].includes(z.codePointAt(0))), 'kein Gedankenstrich, kein Ersatzzeichen');
  });

  console.log('\n' + (n - fehler) + ' von ' + n + ' Faellen bestanden');
  process.exit(fehler ? 1 : 0);
})();
