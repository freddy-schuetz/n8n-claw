// Runde 11b (A1, A2): file_storage nur im Telegram-Zweig, Kanal-Abschnitt je Weg.
// Prueft den ECHTEN Code von "Build System Prompt" aus ../workflows.
//   node tests/kanal.test.js
// Gegenprobe: gegen den Stand vor Runde 11b (dcca401) faellt der Test durch
// (file_storage stand in jedem Prompt, einen Abschnitt KANAL gab es nicht).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'n8n-claw-agent.json'), 'utf8'));
const code = wf.nodes.find(n => n.name === 'Build System Prompt').parameters.jsCode;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const bauen = new AsyncFunction('$', '$now', code);
const NOW_TEXT = 'Samstag, 24 Oktober 2026, 16:00';

const AGENTS = [
  { key: 'file_storage', content: 'FILE STORAGE: send_file marker' },
  { key: 'mcp_instructions', content: 'Du hast MCP.\n\n## Registry\nAlle aktiven Server.' },
  { key: 'onboarding', content: 'When setup_done is false' },
];

function umgebung(merge) {
  const daten = {
    'Load Soul': [{ key: 'communication', content: 'You communicate with the SLT team.' }],
    // Kartesisches Produkt wie live: jede Zeile mehrfach
    'Load Agents Config': [...AGENTS, ...AGENTS],
    'Load User Profile': [{ display_name: 'Gretel Muster', name: 'gretel', timezone: 'Europe/Vienna', preferences: {}, context: '', setup_done: true }],
    'Load Conversation History': [{}],
    'Merge Input': [merge],
    'Load MCP Servers': [{ server_name: 'SharePoint', mcp_url: 'https://x/mcp/sp', tools: ['search_files', 'read_file'] }],
    'Load Active Projects': [],
    'Load Insights': [{ id: 1, content: 'mag kurze Antworten' }],
    'Load Preferences': [{ id: 2, content: 'duzen' }],
  };
  const $ = (name) => {
    if (!(name in daten)) throw new Error('unbekannter Knoten: ' + name);
    const items = daten[name].map(json => ({ json }));
    return { all: () => items, first: () => items[0] };
  };
  const $now = { setZone: () => ({ toFormat: () => NOW_TEXT }) };
  return { $, $now };
}
async function prompt(merge) {
  globalThis.__jetzt = '2026-10-24T14:00:00Z';
  const u = umgebung(merge);
  const [r] = await bauen(u.$, u.$now);
  delete globalThis.__jetzt;
  return r.json;
}
const kanal = sp => {
  const a = sp.indexOf('# KANAL\n');
  if (a < 0) return null;
  const e = sp.indexOf('\n\n', a + 8);
  return e < 0 ? sp.slice(a) : sp.slice(a, e);
};

const BASIS = { userMessage: 'Hi', userId: 'x', qualifiedUserId: 'web:gretel' };
const WEGE = {
  'Telegram direkt': { ...BASIS, sessionId: 'telegram:42', chatId: '42', source: 'telegram', qualifiedUserId: 'telegram:42' },
  'Teams Einzelchat': { ...BASIS, sessionId: 'teams:a:konv1', chatId: null, source: 'teams', _webhookSource: true, historyScope: 'person' },
  'Teams Kanal': { ...BASIS, sessionId: 'teams:19:abc@thread.tacv2', chatId: null, source: 'teams', _webhookSource: true, historyScope: 'session' },
  'Webchat Stream': { ...BASIS, sessionId: 'web:gretel', chatId: null, source: 'web', _webhookSource: false, _streamSource: true, historyScope: 'person' },
  'Webchat Webhook': { ...BASIS, sessionId: 'web:gretel', chatId: null, source: 'web', _webhookSource: true, historyScope: 'person' },
  'Erinnerung task Telegram': { ...BASIS, sessionId: 'telegram:42', chatId: '42', source: 'scheduled_task', _scheduled: true, qualifiedUserId: 'telegram:42' },
  'Erinnerung task Web': { ...BASIS, sessionId: 'web:florian', chatId: null, source: 'scheduled_task', _scheduled: true, qualifiedUserId: 'web:florian' },
  'Heartbeat Nachfrage Teams': { ...BASIS, sessionId: 'teams:a:1bug', chatId: null, source: 'scheduled_action', _scheduled: true, qualifiedUserId: 'web:florian' },
  'Heartbeat Erinnerung Betreiber': { ...BASIS, sessionId: 'telegram:42', chatId: '42', source: 'scheduled_action', _scheduled: true, qualifiedUserId: 'telegram:42' },
  'API Webhook': { ...BASIS, sessionId: 'api:abc', chatId: null, source: 'api', _webhookSource: true },
  'Webhook mit telegram:-Sitzung': { ...BASIS, sessionId: 'telegram:42', chatId: null, source: 'api', _webhookSource: true },
  'Stream mit telegram:-Sitzung': { ...BASIS, sessionId: 'telegram:42', chatId: null, source: 'web', _streamSource: true },
  'Geplant ohne chat_id (Kante)': { ...BASIS, sessionId: 'telegram:', chatId: '', source: 'scheduled_task', _scheduled: true },
};
// [Wort in der Kanalzeile, Telegram-Zweig]
const ERWARTET = {
  'Telegram direkt': ['Telegram', true],
  'Teams Einzelchat': ['Microsoft Teams', false],
  'Teams Kanal': ['Microsoft Teams', false],
  'Webchat Stream': ['Webchat', false],
  'Webchat Webhook': ['Webchat', false],
  'Erinnerung task Telegram': ['Telegram', true],
  'Erinnerung task Web': ['geplanter Lauf', false],
  'Heartbeat Nachfrage Teams': ['geplanter Lauf', false],
  'Heartbeat Erinnerung Betreiber': ['Telegram', true],
  'API Webhook': ['Schnittstelle', false],
  'Webhook mit telegram:-Sitzung': ['Schnittstelle', false],
  'Stream mit telegram:-Sitzung': ['Schnittstelle', false],
  'Geplant ohne chat_id (Kante)': ['geplanter Lauf', false],
};

let n = 0, fehler = 0;
async function fall(name, fn) {
  n++;
  try { await fn(); console.log('PASS', name); }
  catch (e) { fehler++; console.log('FAIL', name, '\n     ', e.message); }
}

(async () => {
  for (const [weg, merge] of Object.entries(WEGE)) {
    await fall(weg, async () => {
      const r = await prompt(merge);
      const sp = r.systemPrompt;
      const [wort, telegram] = ERWARTET[weg];
      const k = kanal(sp);
      assert.ok(k, 'KANAL-Abschnitt fehlt');
      assert.ok(k.split('\n')[1].includes(wort), 'Kanalzeile: ' + k.split('\n')[1]);
      assert.equal(sp.includes('## file_storage'), telegram, 'file_storage geladen: ' + sp.includes('## file_storage'));
      assert.equal(sp.includes('send_file marker'), telegram, 'Inhalt von file_storage');
      assert.equal(k.includes('search_files') && k.includes('read_file') && k.includes('SLT_Alle_M365'), !telegram, 'Regeln fuer Teams und Web');
      assert.equal(/Dateien schicken kannst du dort nicht, auch nicht als Anhang an einen Mail-Entwurf/.test(k), !telegram, 'kein Versand, kein Anhang');
      assert.equal((sp.match(/## onboarding/g) || []).length, 1, 'andere Eintraege bleiben, einmal');
      assert.equal((sp.match(/## mcp_instructions/g) || []).length, 1, 'mcp_instructions einmal');
      assert.ok(sp.includes('## Available MCP Skills:'), 'Serverliste haengt weiter an mcp_instructions');
      assert.ok(![...k].some(z => [0x2013, 0x2014, 0xFFFD].includes(z.codePointAt(0))), 'Gedankenstrich oder Ersatzzeichen im Kanal-Abschnitt');
      assert.ok(!sp.includes('undefined'), 'undefined im Prompt');
      const i = t => sp.indexOf(t);
      assert.ok(i('# USER PROFILE') < i('# VORLIEBEN') && i('# VORLIEBEN') < i('# WHAT YOU KNOW') && i('# WHAT YOU KNOW') < i('# KANAL')
        && i('# KANAL') < i('# RECENT CONVERSATION'), 'Reihenfolge');
      if (merge.source === 'scheduled_task') assert.ok(i('# KANAL') < i('# SCHEDULED TASK'), 'KANAL vor SCHEDULED TASK');
      assert.equal(r.source, merge.source, 'source unveraendert');
      assert.equal(r.sessionId, merge.sessionId || 'telegram:' + merge.chatId, 'sessionId unveraendert');
    });
  }
  const r = await prompt(WEGE['Teams Einzelchat']);
  console.log('\n--- Kanal-Abschnitt Teams:\n' + kanal(r.systemPrompt));
  const t = await prompt(WEGE['Telegram direkt']);
  console.log('\n--- Kanal-Abschnitt Telegram:\n' + kanal(t.systemPrompt));
  const g = await prompt(WEGE['Heartbeat Nachfrage Teams']);
  console.log('\n--- Kanal-Abschnitt geplant:\n' + kanal(g.systemPrompt).split('\n').slice(0, 2).join('\n'));
  console.log('\n' + (n - fehler) + ' von ' + n + ' Faellen bestanden');
  process.exit(fehler ? 1 : 0);
})();
