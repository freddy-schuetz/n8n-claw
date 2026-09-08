// Prueft den Abbruch-Fallback des Agenten mit dem ECHTEN Code aus der
// Workflow-Datei: Knoten "Abbruch-Antwort" (Ersatztext bei Fehler, Limit oder
// leerer Antwort) und "Save Conversation and Log" (kein Tagesprotokoll bei
// einem Ersatztext, Kennzeichnung in den metadata der Assistant-Zeile).
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
const speichern = new AsyncFunction('$input', '$', 'helpers', loadCode('Save Conversation and Log'));

const LIMIT_TEXT = /zu viele Zwischenschritte/;
const FEHLER_TEXT = /technischer Fehler/;

async function abbruchMit(json) {
  const [r] = await abbruch({ first: () => ({ json }) });
  return r.json;
}

// Nachgebautes n8n-Umfeld fuer "Save Conversation and Log"
function umgebung({ antwort, bsp, profil }) {
  const calls = [];
  const helpers = { httpRequest: async (req) => {
    calls.push({ m: req.method, url: String(req.url), body: req.body ? JSON.parse(req.body) : null });
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

  await fall('Fehler als String (429) -> Fehler-Text', async () => {
    const r = await abbruchMit({ error: '429 rate limit' });
    assert.match(r.output, FEHLER_TEXT);
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

  await fall('Fehlerobjekt ohne message wird lesbar gekuerzt', async () => {
    const r = await abbruchMit({ error: { code: 'ECONNRESET' } });
    assert.match(r.output, FEHLER_TEXT);
    assert.match(r._fehler, /ECONNRESET/);
    assert.ok(r._fehler.length <= 300);
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
