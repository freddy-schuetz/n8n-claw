// Prueft alle Workflow-Dateien auf $fromAI-Schluessel, die n8n zur Laufzeit
// ablehnt, und auf die zwei Zusagen aus Runde 9 (19.10.2026). Laeuft auch als
// pre-commit-Haken (.githooks/pre-commit) und blockiert dann den Commit.
//
// Anlass: n8n sperrt seit 2.35.4 (Sicherheitskorrektur GHSA-9x83-43r8-5hwc)
// $fromAI-Schluessel, die Namen interner JavaScript-Eigenschaften tragen. Der
// Aufruf endet dann still mit "Invalid parameter key", die Execution steht
// trotzdem auf success. So waren vom 08.10. bis 19.10.2026 Kalender, Mail,
// SharePoint, Jira, Teams-Bote und Google tot, weil die Skills $fromAI('caller')
// benutzten. Die Liste stammt aus n8n-workflow 2.42.2 (dist/cjs/utils.js,
// unsafeObjectProperties) und ist bis 2.44.x unveraendert. Bei einem n8n-Update
// im Container nachsehen, ob sie gewachsen ist.
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');

const GESPERRT = new Set(['__proto__', 'prototype', 'constructor', 'getPrototypeOf', 'setPrototypeOf',
  'getOwnPropertyDescriptor', 'getOwnPropertyDescriptors', 'defineProperty', 'defineProperties',
  'mainModule', 'binding', '_linkedBinding', '_load', 'prepareStackTrace', '__lookupGetter__',
  '__lookupSetter__', '__defineGetter__', '__defineSetter__', 'caller', 'callee', 'arguments',
  'getBuiltinModule', 'dlopen', 'execve', 'loadEnvFile']);
const GUELTIG = /^[a-zA-Z0-9_-]{1,64}$/;
// n8n erkennt $fromAI ohne Ruecksicht auf Gross- und Kleinschreibung und mit
// Leerzeichen vor der Klammer ($fromai, $fromAi, $fromAI (...): alle gesperrt.
const FROMAI = /\$fromai\s*\(\s*(['"`])((?:(?!\1).)*)\1/gi;

function dateien(ordner) {
  const aus = [];
  for (const e of fs.readdirSync(ordner, { withFileTypes: true })) {
    const p = path.join(ordner, e.name);
    if (e.isDirectory()) aus.push(...dateien(p));
    else if (e.name.endsWith('.json')) aus.push(p);
  }
  return aus;
}

// Nur n8n-Ausdruecke pruefen (Strings mit "=" am Anfang oder mit {{ }}). Code in
// jsCode, der $fromAI-Ausdruecke erst erzeugt (MCP Builder), ist kein Ausdruck.
function ausdruecke(wert, aus) {
  if (typeof wert === 'string') {
    if (wert.startsWith('=') || wert.includes('{{')) aus.push(wert);
  } else if (Array.isArray(wert)) {
    for (const x of wert) ausdruecke(x, aus);
  } else if (wert && typeof wert === 'object') {
    for (const [k, v] of Object.entries(wert)) { if (k !== 'jsCode') ausdruecke(v, aus); }
  }
  return aus;
}

function knoten(obj) {
  if (Array.isArray(obj.nodes)) return obj.nodes;
  const alle = [];
  for (const teil of ['sub', 'server']) if (obj[teil] && Array.isArray(obj[teil].nodes)) alle.push(...obj[teil].nodes);
  return alle;
}

let fehler = 0, schluessel = 0;
function melde(text) { fehler++; console.log('  FEHL ' + text); }

for (const datei of dateien(path.join(REPO, 'workflows'))) {
  const rel = path.relative(REPO, datei);
  let obj;
  try { obj = JSON.parse(fs.readFileSync(datei, 'utf8')); } catch (e) { melde(rel + ': kein gueltiges JSON (' + e.message + ')'); continue; }
  for (const n of knoten(obj)) {
    for (const a of ausdruecke(n.parameters || {}, [])) {
      for (const m of a.matchAll(FROMAI)) {
        const k = m[2];
        if (k.includes('${')) continue;
        schluessel++;
        if (GESPERRT.has(k)) melde(rel + ' / ' + n.name + ': $fromAI-Schluessel "' + k + '" ist in n8n gesperrt');
        else if (!GUELTIG.test(k)) melde(rel + ' / ' + n.name + ': $fromAI-Schluessel "' + k + '" ist ungueltig');
      }
    }
    // Zusage 1: das Feld "caller" im Sub-Workflow-Eingang wird ueber callerid
    // befuellt, sonst setzt der MCP Client die Kennung nicht.
    if (String(n.type || '').endsWith('toolWorkflow')) {
      const werte = ((n.parameters || {}).workflowInputs || {}).value || {};
      if (typeof werte.caller === 'string' && !/\$fromai\s*\(\s*['"`]callerid['"`]/i.test(werte.caller)) {
        melde(rel + ' / ' + n.name + ': Feld caller wird nicht ueber $fromAI(\'callerid\') befuellt');
      }
    }
  }
}

// Zusage 2: Sonnet 5 denkt ohne ausdrueckliches Nein, und n8n spielt dann
// fruehere Werkzeugaufrufe leer zurueck (n8n-Issue #40360). Ueberall, wo
// claude-sonnet-5 laeuft, ist das Denken deshalb aus. Sonnet 5.5, Opus 5.5,
// Haiku 5.5 und Fable lehnen "aus" dagegen mit 400 ab; sie gehoeren erst nach
// dem n8n-Fix fuer #40360 in einen Workflow (Entscheidung Freddy, 18.10.2026).
const DENKT_UNGEFRAGT = new Set(['claude-sonnet-5']);
const ERST_NACH_FIX = new Set(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5', 'claude-fable-5-1']);
let agentClaude = false;
for (const datei of dateien(path.join(REPO, 'workflows'))) {
  const rel = path.relative(REPO, datei);
  let obj;
  try { obj = JSON.parse(fs.readFileSync(datei, 'utf8')); } catch (e) { continue; }
  for (const n of knoten(obj)) {
    if (!String(n.type || '').endsWith('lmChatAnthropic')) continue;
    if (rel.endsWith('n8n-claw-agent.json') && n.name === 'Claude') agentClaude = true;
    const p = n.parameters || {};
    const modell = (p.model && typeof p.model === 'object') ? p.model.value : p.model;
    const v = Number(n.typeVersion);
    const opts = p.options || {};
    const aus = v >= 1.5 ? opts.thinkingMode === 'disabled' : opts.thinking === false;
    if (DENKT_UNGEFRAGT.has(modell) && !aus) melde(rel + ' / ' + n.name + ': ' + modell + ' ohne ausdrueckliches Denken aus (typeVersion ' + v + ')');
    if (ERST_NACH_FIX.has(modell)) melde(rel + ' / ' + n.name + ': ' + modell + ' erst nach dem n8n-Fix fuer Issue #40360 einsetzen (lehnt Denken aus mit 400 ab)');
  }
}
if (!agentClaude) melde('Agent: Knoten Claude fehlt');

console.log(schluessel + ' $fromAI-Schluessel geprueft, ' + fehler + ' Fehler');
process.exit(fehler ? 1 : 0);
