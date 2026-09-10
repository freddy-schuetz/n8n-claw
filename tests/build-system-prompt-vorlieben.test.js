// Runde 6 (10.09.2026): Vorlieben der sprechenden Person (Anrede, feste Wuensche)
// stehen bei jeder Anfrage im Systemprompt, geladen von "Load Preferences", statt
// von der Gedaechtnissuche abzuhaengen. Prueft den ECHTEN Code von
// "Build System Prompt" aus der Workflow-Datei.
//   node tests/build-system-prompt-vorlieben.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'n8n-claw-agent.json'), 'utf8'));
const code = wf.nodes.find(n => n.name === 'Build System Prompt').parameters.jsCode;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const bauen = new AsyncFunction('$', '$now', code);
const JETZT = '2026-09-10T12:30:00Z';
const NOW_TEXT = 'Donnerstag, 10 September 2026, 14:30';

function umgebung({ prefs, ohnePrefsKnoten }) {
  const daten = {
    'Load Soul': [{ key: 'core', content: 'Du bist Rupert.' }],
    'Load Agents Config': [],
    'Load User Profile': [{ display_name: 'Barbara Walzer', name: 'barbara', timezone: 'Europe/Vienna', preferences: {}, context: '', setup_done: true }],
    'Load Conversation History': [],
    'Merge Input': [{ sessionId: 'teams:a:x', qualifiedUserId: 'web:barbara', userId: 'web:barbara', userMessage: 'Hi', source: 'teams', historyScope: 'person' }],
    'Load MCP Servers': [],
    'Load Active Projects': [],
    'Load Insights': [],
    'Load Preferences': prefs,
  };
  if (ohnePrefsKnoten) delete daten['Load Preferences'];
  const $ = (name) => {
    if (!(name in daten)) throw new Error('unbekannter Knoten: ' + name);
    const items = daten[name].map(json => ({ json }));
    return { all: () => items, first: () => items[0] };
  };
  const $now = { setZone: () => ({ toFormat: () => NOW_TEXT }) };
  return { $, $now };
}
async function prompt(opts) {
  globalThis.__jetzt = JETZT;
  const u = umgebung(opts);
  const [r] = await bauen(u.$, u.$now);
  delete globalThis.__jetzt;
  return r.json.systemPrompt;
}

let n = 0, fehler = 0;
async function fall(name, fn) {
  n++;
  try { await fn(); console.log('PASS', name); }
  catch (e) { fehler++; console.log('FAIL', name, '\n     ', e.message); }
}

(async () => {
  await fall('Vorlieben stehen als eigener Abschnitt im Prompt, vor den Insights', async () => {
    const sp = await prompt({ prefs: [
      { id: 954, content: "Barbara Walzer möchte in Zukunft immer 'Babs' genannt werden." },
      { id: 953, content: "Barbara nennt den Assistenten lieber 'Nannerl'." }
    ] });
    assert.match(sp, /# VORLIEBEN DIESER PERSON \(verbindlich\)/);
    assert.match(sp, /- Barbara Walzer möchte in Zukunft immer 'Babs' genannt werden\./);
    assert.match(sp, /- Barbara nennt den Assistenten lieber 'Nannerl'\./);
    assert.ok(sp.indexOf('# USER PROFILE') < sp.indexOf('# VORLIEBEN DIESER PERSON'), 'nach dem Profil');
    assert.ok(sp.indexOf('# VORLIEBEN DIESER PERSON') < sp.indexOf('# RECENT CONVERSATION'), 'vor dem Verlauf');
    assert.match(sp, /gelten in jeder Antwort, ohne dass du sie erwaehnst/);
  });
  await fall('ohne Vorlieben (alwaysOutputData liefert ein leeres Item) kein Abschnitt', async () => {
    const sp = await prompt({ prefs: [{}] });
    assert.doesNotMatch(sp, /VORLIEBEN DIESER PERSON/);
  });
  await fall('ohne den Knoten (alte Instanz) laeuft der Prompt trotzdem', async () => {
    const sp = await prompt({ prefs: [], ohnePrefsKnoten: true });
    assert.doesNotMatch(sp, /VORLIEBEN DIESER PERSON/);
    assert.match(sp, /# SOUL/);
  });
  await fall('gleichlautende Eintraege (Florian 974/975) erscheinen einmal', async () => {
    const sp = await prompt({ prefs: [
      { id: 974, content: 'Florian möchte bei Jira-Abfragen das Startdatum sehen.' },
      { id: 975, content: 'Florian möchte bei Jira-Abfragen das Startdatum sehen. ' }
    ] });
    assert.equal((sp.match(/Startdatum sehen/g) || []).length, 1);
  });
  await fall('Fehlerzeile von continueOnFail (kein content) wird ignoriert', async () => {
    const sp = await prompt({ prefs: [{ error: 'relation does not exist' }] });
    assert.doesNotMatch(sp, /VORLIEBEN DIESER PERSON/);
  });
  console.log('\n' + (n - fehler) + ' von ' + n + ' Faellen bestanden');
  process.exit(fehler ? 1 : 0);
})();
