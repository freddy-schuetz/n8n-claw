// Prueft den Abbruch-Fallback des Agenten mit dem ECHTEN Code aus der
// Workflow-Datei: Knoten "Abbruch-Antwort" (Ersatztext bei Fehler, Limit oder
// leerer Antwort) und "Save Conversation and Log" (kein Tagesprotokoll bei
// einem Ersatztext, Kennzeichnung in den metadata der Assistant-Zeile).
// Seit Runde 11 Teilrunde 2 (B12, E3): ein Modellfehler (Fehlerausgang des AI
// Agent ohne Limit) bekommt den ehrlichen Text ohne Zusage, die nicht gehalten
// wird, und einen Vermerk mit metadata.alarm = agent_abbruch im scope betrieb
// (30 Tage); die Werkzeugwache meldet ihn Freddy. Diese Faelle laufen mit
// this.helpers, sonst saehe der Test den Vermerk nie.
//   node tests/abbruch-antwort.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'n8n-claw-agent.json'), 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function loadCode(nodeName) {
  const node = wf.nodes.find(n => n.name === nodeName && (n.parameters || {}).jsCode);
  if (!node) throw new Error(`Node ${nodeName} nicht gefunden`);
  return node.parameters.jsCode
    .replace(/\{\{SUPABASE_URL\}\}/g, 'http://stub.local')
    .replace(/\{\{SUPABASE_SERVICE_KEY\}\}/g, 'stub-key');
}

const abbruch = new AsyncFunction('$input', loadCode('Abbruch-Antwort'));
const abbruchMitUmfeld = new AsyncFunction('$input', '$', loadCode('Abbruch-Antwort'));
const speichernRoh = new AsyncFunction('$input', '$', 'helpers', '$execution', loadCode('Save Conversation and Log'));
// Runde 11b: der Knoten liest die Werkzeuge dieser Ausfuehrung aus dem
// tool_audit_log; ohne $execution gilt der Lauf als persoenlich (siehe
// tests/b3-tagesprotokoll.test.js). Hier laeuft kein Werkzeug.
const speichern = (i, $, h) => speichernRoh(i, $, h, { id: '4711' });

const LIMIT_TEXT = /zu viele Zwischenschritte/;
const FEHLER_TEXT = /technischer Fehler/;
const E3 = 'Da ist bei mir gerade ein technisches Problem aufgetreten, deine Anfrage kann ich im Moment nicht bearbeiten. '
  + 'Freddy wird automatisch benachrichtigt. Versuch es bitte in einer Viertelstunde noch einmal.';
const TAGE30 = 30 * 24 * 3600 * 1000;

async function abbruchMit(json) {
  const [r] = await abbruch({ first: () => ({ json }) });
  return r.json;
}

function modellText(output) {
  assert.equal(output, E3);
  assert.match(output, /technisches Problem aufgetreten/);
  assert.match(output, /Freddy wird automatisch benachrichtigt/);
  assert.match(output, /Viertelstunde/);
  assert.doesNotMatch(output, /gleich noch einmal/);
}

// Knoten mit this.helpers und $: (Ergebnis, POST-Aufrufe).
async function mitVermerk(json, { quelle, nachricht, wirft } = {}) {
  const calls = [];
  const ctx = { helpers: { httpRequest: async (req) => {
    calls.push({ m: req.method, url: String(req.url), headers: req.headers, body: req.body ? JSON.parse(req.body) : null });
    if (wirft) throw new Error('503');
    return '';
  } } };
  const $ = (name) => ({ first: () => {
    if (name === 'Merge Input') return { json: { source: quelle || 'teams', qualifiedUserId: 'entra:abc', sessionId: 'teams:a:k1', userMessage: nachricht || 'Wann ist die naechste Sitzung?' } };
    if (name === 'Build System Prompt') return { json: { heuteBegruesst: false } };
    throw new Error('unbekannter Knoten: ' + name);
  } });
  const [r] = await abbruchMitUmfeld.call(ctx, { first: () => ({ json }) }, $);
  return { r: r.json, calls };
}

function vermerkPruefen(calls, mitAlarm) {
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.m, 'POST');
  assert.equal(c.url, 'http://stub.local/rest/v1/memory_long');
  assert.equal(c.headers.apikey, 'stub-key');
  assert.equal(c.headers.Authorization, 'Bearer stub-key');
  const b = c.body;
  assert.equal(b.scope, 'betrieb');
  assert.equal(b.category, 'error');
  assert.equal(b.importance, 7);
  assert.equal(b.source, 'task_result');
  assert.ok(Math.abs(Date.parse(b.expires_at) - (Date.now() + TAGE30)) < 60000, 'expires_at 30 Tage');
  assert.equal(b.owner_user_id, undefined);
  assert.equal(b.entity_name, undefined);
  assert.equal(b.metadata.fallback, true);
  if (mitAlarm) {
    assert.equal(b.metadata.alarm, 'agent_abbruch');
    assert.ok(b.metadata.grund);
  } else {
    assert.equal(b.metadata.alarm, undefined);
    assert.equal(b.metadata.fehlerart, undefined);
  }
  return b;
}

// Nachgebautes n8n-Umfeld fuer "Save Conversation and Log"
function umgebung({ antwort, bsp, profil }) {
  const calls = [];
  const helpers = { httpRequest: async (req) => {
    calls.push({ m: req.method, url: String(req.url), body: req.body ? JSON.parse(req.body) : null });
    if (req.method === 'GET' && String(req.url).includes('/tool_audit_log')) return [];
    return {};
  } };
  const $ = (name) => ({ first: () => {
    if (name === 'Build System Prompt') return { json: bsp };
    if (name === 'Abbruch-Antwort') return { json: antwort };
    if (name === 'Load User Profile') return { json: profil || { setup_done: true } };
    throw new Error('unbekannter Knoten: ' + name);
  } });
  return { calls, $, helpers };
}
const BSP = { userMessage: 'Wie spaet ist es?', sessionId: 'teams:a:konv1', userId: 'entra:abc', qualifiedUserId: 'entra:abc', source: 'teams', _webhookSource: true, metadata: { display_name: 'Sophie Strasser' } };
const nur = (calls, m, teil) => calls.filter(c => c.m === m && c.url.includes(teil));

let n = 0, fehler = 0;
async function fall(name, fn) {
  n++;
  try { await fn(); console.log('PASS', name); }
  catch (e) { fehler++; console.log('FAIL', name, '\n     ', e.message); }
}

(async () => {
  console.log('--- Abbruch-Antwort ---');
  await fall('normale Antwort bleibt unveraendert, _fallback false', async () => {
    const r = await abbruchMit({ output: 'Text', extra: 1 });
    assert.equal(r.output, 'Text');
    assert.equal(r._fallback, false);
    assert.equal(r.extra, 1);
  });

  await fall('Fehlerobjekt mit "Max iterations" -> Limit-Text', async () => {
    const r = await abbruchMit({ error: { message: 'Max iterations (15) reached' } });
    assert.match(r.output, LIMIT_TEXT);
    assert.equal(r._fallback, true);
    assert.match(r._fehler, /Max iterations/);
  });

  await fall('Fehler als String (429) -> ehrlicher Text ohne Zusage (E3)', async () => {
    const r = await abbruchMit({ error: '429 rate limit' });
    modellText(r.output);
    assert.equal(r._fallback, true);
    assert.equal(r._fehler, '429 rate limit');
  });

  await fall('Ausgabe "Agent stopped due to max iterations." -> Limit-Text', async () => {
    const r = await abbruchMit({ output: 'Agent stopped due to max iterations.' });
    assert.match(r.output, LIMIT_TEXT);
    assert.equal(r._fallback, true);
    assert.equal(r._fehler, 'max_iterations');
  });

  await fall('leere Ausgabe -> Fehler-Text', async () => {
    const r = await abbruchMit({ output: '' });
    assert.match(r.output, FEHLER_TEXT);
    assert.equal(r._fallback, true);
    assert.equal(r._fehler, 'leere Antwort');
  });

  await fall('Fehlerobjekt ohne message wird lesbar gekuerzt, ehrlicher Text (E3)', async () => {
    const r = await abbruchMit({ error: { code: 'ECONNRESET' } });
    modellText(r.output);
    assert.match(r._fehler, /ECONNRESET/);
    assert.ok(r._fehler.length <= 300);
  });

  console.log('--- Abbruch-Antwort: Vermerk und Alarm (Runde 11 Teilrunde 2) ---');
  await fall('21.10.2026 (Ausfuehrung 202591, Guthaben): E3-Text, Vermerk betrieb mit Alarm, Art anfrage_oder_guthaben', async () => {
    // Am Knoten kam nur die n8n-Meldung zu HTTP 400 an; dieselbe Meldung kommt
    // nach einem Modellwechsel, mit Denken oder bei zu langem Prompt. Darum
    // nicht guthaben (die Wache schickte sonst immer zum Anthropic-Konto).
    const { r, calls } = await mitVermerk({ error: 'Bad request - please check your parameters' });
    modellText(r.output);
    assert.equal(r._fallback, true);
    assert.equal(r._fehler, 'Bad request - please check your parameters');
    const b = vermerkPruefen(calls, true);
    assert.equal(b.metadata.fehlerart, 'anfrage_oder_guthaben');
    assert.equal(b.metadata.grund, 'Bad request - please check your parameters');
    assert.equal(b.metadata.quelle, 'teams');
    assert.equal(b.content, 'Agent-Abbruch (technischer Fehler) bei entra:abc in Sitzung teams:a:k1: Bad request - please check your parameters');
  });

  await fall('Guthaben, Schluessel, Ueberlast, Anfrage und sonst: E3-Text und Alarm, Art als Hinweis', async () => {
    const faelle = [
      ['Payment required - perhaps check your payment details?', 'guthaben'],
      ['400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}', 'guthaben'],
      ['400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}', 'anfrage_oder_guthaben'],
      ['Authorization failed - please check your credentials', 'schluessel'],
      ['401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', 'schluessel'],
      ['Forbidden - perhaps check your credentials?', 'schluessel'],
      ['The service is receiving too many requests from you', 'ueberlast'],
      ['The service failed to process your request', 'ueberlast'],
      ['529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 'ueberlast'],
      ['503 Service Unavailable', 'ueberlast'],
      ['socket hang up', 'sonst'],
    ];
    for (const [msg, art] of faelle) {
      const { r, calls } = await mitVermerk({ error: msg });
      modellText(r.output);
      const b = vermerkPruefen(calls, true);
      assert.equal(b.metadata.fehlerart, art, msg);
    }
    const { r, calls } = await mitVermerk({ error: { code: 'ECONNRESET' } });
    modellText(r.output);
    assert.equal(vermerkPruefen(calls, true).metadata.fehlerart, 'sonst');
    // Fehlerobjekt nur mit der Beschreibung des Anbieters: die sagt Guthaben.
    const x = await mitVermerk({ error: { description: 'Your credit balance is too low to access the Anthropic API.' } });
    modellText(x.r.output);
    assert.equal(vermerkPruefen(x.calls, true).metadata.fehlerart, 'guthaben');
  });

  await fall('Limit (Fehler und Ausgabe): alter Limit-Text, Vermerk betrieb mit Ablauf, ohne Alarm', async () => {
    for (const json of [{ error: { message: 'Max iterations (15) reached' } }, { output: 'Agent stopped due to max iterations.' }]) {
      const { r, calls } = await mitVermerk(json);
      assert.match(r.output, LIMIT_TEXT);
      const b = vermerkPruefen(calls, false);
      assert.match(b.content, /^Agent-Abbruch \(zu viele Zwischenschritte\)/);
    }
  });

  await fall('leere Antwort: alter Text, Vermerk betrieb mit Ablauf, ohne Alarm', async () => {
    const { r, calls } = await mitVermerk({ output: '   ' });
    assert.match(r.output, FEHLER_TEXT);
    assert.equal(r._fehler, 'leere Antwort');
    vermerkPruefen(calls, false);
  });

  await fall('geplanter Lauf und Nachfrage mit Modellfehler: eigener Text, Alarm trotzdem', async () => {
    let x = await mitVermerk({ error: 'Bad request - please check your parameters' }, { quelle: 'scheduled_task' });
    assert.match(x.r.output, /geplante Aufgabe/);
    assert.equal(vermerkPruefen(x.calls, true).metadata.quelle, 'scheduled_task');
    x = await mitVermerk({ error: 'Bad request - please check your parameters' },
      { quelle: 'heartbeat', nachricht: 'Du fragst proaktiv beim User nach alten offenen Vorhaben. Sende EINE kurze Nachricht.' });
    assert.equal(x.r.output, '[SKIP]');
    vermerkPruefen(x.calls, true);
  });

  await fall('normale Antwort: kein Vermerk', async () => {
    const { r, calls } = await mitVermerk({ output: 'Es ist 14:05.' });
    assert.equal(r.output, 'Es ist 14:05.');
    assert.equal(calls.length, 0);
  });

  await fall('Vermerk scheitert: der Text kommt trotzdem', async () => {
    const { r, calls } = await mitVermerk({ error: 'Bad request - please check your parameters' }, { wirft: true });
    modellText(r.output);
    assert.equal(calls.length, 1);
  });

  await fall('kein Bot-Token im Agenten, kein Guthaben- oder Kostenhinweis im Text', async () => {
    const code = loadCode('Abbruch-Antwort');
    assert.doesNotMatch(code, /api\.telegram\.org|TELEGRAM_BOT_TOKEN|\{\{TELEGRAM/);
    assert.doesNotMatch(E3, /Guthaben|Kosten|Anthropic|credit|Euro|Konto/i);
    assert.ok(code.includes(E3), 'E3-Text steht woertlich im Knoten');
  });

  console.log('--- Save Conversation and Log ---');
  await fall('Ersatztext: kein memory_daily-POST, metadata.fallback true in der Assistant-Zeile', async () => {
    const u = umgebung({ bsp: BSP, antwort: { output: 'Da bin ich haengen geblieben.', _fallback: true, _fehler: 'Max iterations (15) reached' } });
    const [r] = await speichern({ first: () => ({ json: {} }) }, u.$, u.helpers);
    assert.equal(nur(u.calls, 'POST', '/memory_daily').length, 0);
    const konv = nur(u.calls, 'POST', '/conversations');
    assert.equal(konv.length, 2);
    assert.equal(konv[0].body.role, 'user');
    assert.equal(konv[1].body.role, 'assistant');
    assert.equal(konv[1].body.content, 'Da bin ich haengen geblieben.');
    assert.equal(konv[1].body.metadata.fallback, true);
    assert.equal(konv[1].body.metadata.fehler, 'Max iterations (15) reached');
    assert.equal(konv[1].body.metadata.source, 'teams');
    assert.equal(konv[1].body.session_id, 'teams:a:konv1');
    assert.equal(r.json.output, 'Da bin ich haengen geblieben.');
    assert.equal(r.json._fallback, true);
  });

  await fall('normale Antwort: memory_daily-POST vorhanden, metadata.fallback false', async () => {
    const u = umgebung({ bsp: BSP, antwort: { output: 'Es ist 14:05.', _fallback: false } });
    const [r] = await speichern({ first: () => ({ json: {} }) }, u.$, u.helpers);
    const daily = nur(u.calls, 'POST', '/memory_daily');
    assert.equal(daily.length, 1);
    assert.match(daily[0].body.content, /Wie spaet ist es\?.*Es ist 14:05\./);
    const konv = nur(u.calls, 'POST', '/conversations');
    assert.equal(konv.length, 2);
    assert.equal(konv[1].body.metadata.fallback, false);
    assert.equal(konv[1].body.metadata.fehler, null);
    assert.equal(r.json.output, 'Es ist 14:05.');
    assert.equal(r.json._fallback, false);
    assert.equal(r.json.saved, true);
  });

  await fall('display_name aus metadata landet in beiden Verlaufszeilen', async () => {
    const u = umgebung({ bsp: BSP, antwort: { output: 'Servus.', _fallback: false } });
    await speichern({ first: () => ({ json: {} }) }, u.$, u.helpers);
    const konv = nur(u.calls, 'POST', '/conversations');
    assert.equal(konv[0].body.metadata.display_name, 'Sophie Strasser');
    assert.equal(konv[1].body.metadata.display_name, 'Sophie Strasser');
    assert.equal(konv[0].body.metadata.source, 'teams');
  });

  await fall('ohne display_name: null, Speicherziel bleibt die sessionId', async () => {
    const u = umgebung({ bsp: Object.assign({}, BSP, { metadata: {} }), antwort: { output: 'Servus.', _fallback: false } });
    await speichern({ first: () => ({ json: {} }) }, u.$, u.helpers);
    const konv = nur(u.calls, 'POST', '/conversations');
    assert.equal(konv[0].body.metadata.display_name, null);
    assert.equal(konv[0].body.session_id, 'teams:a:konv1');
  });

  await fall('[SKIP] wird weiter verworfen (nichts gespeichert)', async () => {
    const u = umgebung({ bsp: BSP, antwort: { output: '[SKIP]', _fallback: false } });
    const r = await speichern({ first: () => ({ json: {} }) }, u.$, u.helpers);
    assert.equal(r.length, 0);
    assert.equal(u.calls.length, 0);
  });

  console.log('\n' + (n - fehler) + ' von ' + n + ' Faellen bestanden');
  process.exit(fehler ? 1 : 0);
})();
