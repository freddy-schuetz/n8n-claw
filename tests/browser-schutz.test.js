// Prueft die Schutzregeln des Browser-Werkzeugs mit dem echten Knotencode:
// zu duenne Auftraege und Microsoft-Adressen starten keinen Browser, alles andere schon.
//   node tests/browser-schutz.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'browser-use.json'), 'utf8'));
const code = wf.nodes.find(n => n.name === 'Route Browser Action').parameters.jsCode;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Der Knoten liest seine Angaben aus dem Feld query (JSON-Text), so schickt sie
// der toolWorkflow-Aufrufer. Ohne query bleibt action leer.
async function lauf(raw) {
  const aufrufe = [];
  const $input = { first: () => ({ json: { query: JSON.stringify(raw) } }) };
  const helpers = { httpRequest: async (req) => { aufrufe.push(req); return { status: 'completed', result: 'ok' }; } };
  const fn = new AsyncFunction('$input', 'helpers', code);
  const out = await fn($input, helpers);
  return { json: out[0].json, aufrufe };
}

let n = 0, fehler = 0;
async function fall(name, fn) {
  n++;
  try { await fn(); console.log('PASS', name); }
  catch (e) { fehler++; console.log('FAIL', name, '|', e.message.slice(0, 200)); }
}

(async () => {
  await fall('Platzhalter startet keinen Browser', async () => {
    const r = await lauf({ action: 'task', task: 'placeholder' });
    assert.equal(r.json.success, false);
    assert.match(r.json.error, /Kein brauchbarer Auftrag/);
    assert.equal(r.aufrufe.length, 0);
  });
  await fall('ein einzelnes Wort ohne Adresse startet keinen Browser', async () => {
    const r = await lauf({ action: 'task', task: 'Suche' });
    assert.equal(r.json.success, false);
    assert.match(r.json.error, /Kein brauchbarer Auftrag/);
  });
  await fall('kurzer Auftrag mit Adresse laeuft', async () => {
    const r = await lauf({ action: 'task', task: 'Oeffne orf.at', url: 'https://orf.at' });
    assert.doesNotMatch(String(r.json.error || ''), /Kein brauchbarer Auftrag/);
    assert.equal(r.aufrufe.length, 1);
  });
  await fall('dreiwortiger Auftrag ohne Adresse laeuft', async () => {
    const r = await lauf({ action: 'task', task: 'Screenshot von heise machen' });
    assert.doesNotMatch(String(r.json.error || ''), /Kein brauchbarer Auftrag/);
  });
  await fall('Microsoft-Adresse wird abgewiesen', async () => {
    const r = await lauf({ action: 'task', task: 'Lies den letzten Chat vor', url: 'https://teams.microsoft.com/x' });
    assert.equal(r.json.success, false);
    assert.match(r.json.error, /Microsoft-Dienste/);
    assert.equal(r.aufrufe.length, 0);
  });
  await fall('Microsoft-Domain wird abgewiesen', async () => {
    const r = await lauf({ action: 'task', task: 'Datei dort herunterladen', domain: 'sharepoint.com' });
    assert.equal(r.json.success, false);
    assert.match(r.json.error, /Microsoft-Dienste/);
  });
  await fall('Fremdseite mit Outlook im Auftragstext laeuft', async () => {
    const r = await lauf({ action: 'task', task: 'Trage mich beim Newsletter ein wie in Outlook. Danach abmelden', url: 'https://ski-live.com' });
    assert.doesNotMatch(String(r.json.error || ''), /Microsoft-Dienste/);
    assert.equal(r.aufrufe.length, 1);
  });
  await fall('Fremdseite backoffice.com laeuft', async () => {
    const r = await lauf({ action: 'task', task: 'Melde mich zum Newsletter an', url: 'https://backoffice.com/news' });
    assert.doesNotMatch(String(r.json.error || ''), /Microsoft-Dienste/);
  });
  await fall('list_sessions bleibt unberuehrt', async () => {
    const r = await lauf({ action: 'list_sessions' });
    assert.equal(r.json.success, true);
  });
  console.log('');
  console.log((n - fehler) + ' von ' + n + ' Faellen bestanden');
  process.exit(fehler ? 1 : 0);
})();
