// Prueft den Verlaufsteil von "Build System Prompt" mit dem ECHTEN Code aus der
// Workflow-Datei: Reihenfolge (aelteste zuerst), Dedup per id, relative Zeit,
// Kanaltag nur bei Fremdkanal, Sprechername in Kanal-Sitzungen, Begruessungszeile.
// Die Zeitlogik laeuft ueber globalThis.__jetzt, $now bleibt nur fuer die Uhrzeit.
//   node tests/build-system-prompt-verlauf.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'n8n-claw-agent.json'), 'utf8'));
const code = wf.nodes.find(n => n.name === 'Build System Prompt').parameters.jsCode;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const bauen = new AsyncFunction('$', '$now', code);

// Dienstag, 08.09.2026, 14:30 Wien (CEST = UTC+2)
const JETZT = '2026-09-08T12:30:00Z';
const NOW_TEXT = 'Dienstag, 08 September 2026, 14:30';

function umgebung({ merge, rows, profil }) {
  const daten = {
    'Load Soul': [{ key: 'core', content: 'Du bist Rupert.' }],
    'Load Agents Config': [],
    'Load User Profile': [profil || { display_name: 'Gretel Muster', name: 'gretel', timezone: 'Europe/Vienna', preferences: {}, context: '', setup_done: true }],
    'Load Conversation History': rows,
    'Merge Input': [merge],
    'Load MCP Servers': [],
    'Load Active Projects': [],
    'Load Insights': [],
  };
  const $ = (name) => {
    if (!(name in daten)) throw new Error('unbekannter Knoten: ' + name);
    const items = daten[name].map(json => ({ json }));
    return { all: () => items, first: () => items[0] };
  };
  const $now = { setZone: () => ({ toFormat: () => NOW_TEXT }) };
  return { $, $now };
}
async function prompt(opts) {
  globalThis.__jetzt = opts.jetzt || JETZT;
  const u = umgebung(opts);
  const [r] = await bauen(u.$, u.$now);
  delete globalThis.__jetzt;
  return r.json;
}
const verlauf = sp => sp.slice(sp.indexOf('# RECENT CONVERSATION'));
const zeile = (sp, teil) => verlauf(sp).split('\n').find(l => l.includes(teil));

const PERSON_WEB = { sessionId: 'web:gretel', qualifiedUserId: 'web:gretel', userId: 'web:gretel', userMessage: 'Hi', source: 'web', historyScope: 'person' };
const PERSON_TEAMS = { sessionId: 'teams:a:konv1', qualifiedUserId: 'web:gretel', userId: 'web:gretel', userMessage: 'Hi', source: 'teams', historyScope: 'person' };
const KANAL = { sessionId: 'teams:19:abc@thread.tacv2', qualifiedUserId: 'entra:1', userId: 'entra:1', userMessage: 'Hi', source: 'teams', historyScope: 'session' };

// Zeilen in der Reihenfolge, wie sie aus der DB kommen (neueste zuerst)
const ZEILEN = [
  { id: 2, session_id: 'web:gretel', role: 'assistant', content: 'Servus Gretel.', created_at: '2026-09-08T12:19:00Z', metadata: {} },
  { id: 1, session_id: 'web:gretel', role: 'user', content: 'Hallo Rupert', created_at: '2026-09-08T12:18:00Z', metadata: {} },
  { id: 1, session_id: 'web:gretel', role: 'user', content: 'Hallo Rupert', created_at: '2026-09-08T12:18:00Z', metadata: {} },
  { id: 3, session_id: 'teams:a:konv1', role: 'user', content: 'Was steht morgen an?', created_at: '2026-09-07T12:05:00Z', metadata: { display_name: 'Gretel Muster' } },
  { id: 4, session_id: 'web:gretel', role: 'user', content: 'Alte Frage', created_at: '2026-09-01T07:12:00Z', metadata: {} },
];

let n = 0, fehler = 0;
async function fall(name, fn) {
  n++;
  try { await fn(); console.log('PASS', name); }
  catch (e) { fehler++; console.log('FAIL', name, '\n     ', e.message); }
}

(async () => {
  await fall('Reihenfolge aelteste zuerst, Dedup per id', async () => {
    const r = await prompt({ merge: PERSON_WEB, rows: ZEILEN });
    const v = verlauf(r.systemPrompt);
    assert.equal((v.match(/Hallo Rupert/g) || []).length, 1, 'doppelte id nur einmal');
    const i4 = v.indexOf('Alte Frage'), i3 = v.indexOf('Was steht morgen an?'), i1 = v.indexOf('Hallo Rupert'), i2 = v.indexOf('Servus Gretel.');
    assert.ok(i4 < i3 && i3 < i1 && i1 < i2, 'Reihenfolge: ' + [i4, i3, i1, i2].join(','));
  });

  await fall('relative Zeit: "vor 12 Minuten", "gestern 14:05", "Di 01.09. 09:12"', async () => {
    const r = await prompt({ merge: PERSON_WEB, rows: ZEILEN });
    assert.match(zeile(r.systemPrompt, 'Hallo Rupert'), /^\[vor 12 Minuten\] user: Hallo Rupert$/);
    assert.match(zeile(r.systemPrompt, 'Servus Gretel.'), /^\[vor 11 Minuten\] assistant: Servus Gretel\.$/);
    assert.match(zeile(r.systemPrompt, 'Was steht morgen an?'), /^\[gestern 14:05, per Teams\] user: Was steht morgen an\?$/);
    assert.match(zeile(r.systemPrompt, 'Alte Frage'), /^\[Di 01\.09\. 09:12\] user: Alte Frage$/);
  });

  await fall('"gerade eben", "vor 1 Minute", "vor 3 Stunden", "heute 07:00" (aelter als 6 Stunden)', async () => {
    const rows = [
      { id: 11, session_id: 'web:gretel', role: 'user', content: 'A', created_at: '2026-09-08T12:29:50Z' },
      { id: 12, session_id: 'web:gretel', role: 'user', content: 'B', created_at: '2026-09-08T12:29:00Z' },
      { id: 13, session_id: 'web:gretel', role: 'user', content: 'C', created_at: '2026-09-08T09:29:00Z' },
      { id: 14, session_id: 'web:gretel', role: 'user', content: 'D', created_at: '2026-09-08T05:00:00Z' },
      { id: 15, session_id: 'web:gretel', role: 'user', content: 'E', created_at: '2026-09-08T11:29:00Z' },
    ];
    const r = await prompt({ merge: PERSON_WEB, rows });
    assert.equal(zeile(r.systemPrompt, 'user: A'), '[gerade eben] user: A');
    assert.equal(zeile(r.systemPrompt, 'user: B'), '[vor 1 Minute] user: B');
    assert.equal(zeile(r.systemPrompt, 'user: C'), '[vor 3 Stunden] user: C');
    assert.equal(zeile(r.systemPrompt, 'user: D'), '[heute 07:00] user: D');
    assert.equal(zeile(r.systemPrompt, 'user: E'), '[vor 1 Stunde] user: E');
  });

  await fall('Kanaltag nur bei Fremdkanal: aus Teams heraus tragen Web-Beitraege "per Web", Teams-Beitraege nichts', async () => {
    const r = await prompt({ merge: PERSON_TEAMS, rows: ZEILEN });
    assert.match(zeile(r.systemPrompt, 'Hallo Rupert'), /^\[vor 12 Minuten, per Web\] user: Hallo Rupert$/);
    assert.match(zeile(r.systemPrompt, 'Was steht morgen an?'), /^\[gestern 14:05\] user: Was steht morgen an\?$/);
    assert.ok(!zeile(r.systemPrompt, 'Was steht morgen an?').includes('per Teams'));
  });

  await fall('Personen-Scope: Ueberschrift nennt beide Kanaele, kein Sprechername', async () => {
    const r = await prompt({ merge: PERSON_TEAMS, rows: ZEILEN });
    assert.ok(r.systemPrompt.includes('# RECENT CONVERSATION (Web und persoenlicher Teams-Chat dieser Person zusammen, aelteste zuerst)'));
    assert.ok(!r.systemPrompt.includes('user (Gretel Muster)'), 'display_name wird im Personen-Scope nicht angezeigt');
  });

  await fall('Kanal-Sitzung: Sprechername aus metadata.display_name, Ueberschrift nennt Mitleser', async () => {
    const rows = [
      { id: 21, session_id: 'teams:19:abc@thread.tacv2', role: 'assistant', content: 'Gern.', created_at: '2026-09-08T12:20:00Z', metadata: { display_name: 'Sophie Strasser' } },
      { id: 20, session_id: 'teams:19:abc@thread.tacv2', role: 'user', content: 'Rupert, was ist mit dem Termin?', created_at: '2026-09-08T12:19:00Z', metadata: { display_name: 'Sophie Strasser' } },
      { id: 19, session_id: 'teams:19:abc@thread.tacv2', role: 'user', content: 'Ohne Namen', created_at: '2026-09-08T12:18:00Z', metadata: {} },
    ];
    const r = await prompt({ merge: KANAL, rows });
    assert.ok(r.systemPrompt.includes('# RECENT CONVERSATION (diese Kanal-Sitzung, mehrere Personen lesen mit)'));
    assert.equal(zeile(r.systemPrompt, 'was ist mit dem Termin'), '[vor 11 Minuten] user (Sophie Strasser): Rupert, was ist mit dem Termin?');
    assert.equal(zeile(r.systemPrompt, 'Gern.'), '[vor 10 Minuten] assistant: Gern.');
    assert.equal(zeile(r.systemPrompt, 'Ohne Namen'), '[vor 12 Minuten] user: Ohne Namen');
  });

  await fall('Begruessungszeile: assistant-Beitrag von heute -> "Heute schon begruesst"', async () => {
    const r = await prompt({ merge: PERSON_WEB, rows: ZEILEN });
    assert.ok(r.systemPrompt.includes('Heute schon begruesst: ohne Gruss direkt zur Sache.'));
    assert.ok(!r.systemPrompt.includes('Erster Kontakt heute'));
  });

  await fall('Begruessungszeile: nur user-Beitraege heute oder assistant von gestern -> "Erster Kontakt heute"', async () => {
    const rows = [
      { id: 31, session_id: 'web:gretel', role: 'user', content: 'Hallo', created_at: '2026-09-08T12:18:00Z' },
      { id: 30, session_id: 'web:gretel', role: 'assistant', content: 'Servus', created_at: '2026-09-07T20:30:00Z' },
    ];
    const r = await prompt({ merge: PERSON_WEB, rows });
    assert.ok(r.systemPrompt.includes('Erster Kontakt heute: einmal kurz begruessen.'));
    assert.ok(!r.systemPrompt.includes('Heute schon begruesst'));
  });

  await fall('Tagesgrenze in der Zeitzone: assistant 23:30 UTC gestern ist 01:30 Wien heute -> schon begruesst', async () => {
    const rows = [{ id: 40, session_id: 'web:gretel', role: 'assistant', content: 'Nachtschicht', created_at: '2026-09-07T23:30:00Z' }];
    const r = await prompt({ merge: PERSON_WEB, rows });
    assert.ok(r.systemPrompt.includes('Heute schon begruesst'));
    assert.match(zeile(r.systemPrompt, 'Nachtschicht'), /^\[heute 01:30\]/);
  });

  await fall('leerer Verlauf (alwaysOutputData-Zeile ohne Felder) -> keine Zeile, "Erster Kontakt heute"', async () => {
    const r = await prompt({ merge: PERSON_WEB, rows: [{}] });
    const v = verlauf(r.systemPrompt).split('\n');
    assert.equal(v[0], '# RECENT CONVERSATION (Web und persoenlicher Teams-Chat dieser Person zusammen, aelteste zuerst)');
    assert.equal(v[1], 'Erster Kontakt heute: einmal kurz begruessen.');
    assert.equal((v[2] || '').trim(), '');
    assert.ok(!r.systemPrompt.includes('undefined: undefined'));
  });

  await fall('altes Zeilenformat ohne id/created_at: Dedup per role:content, Reihenfolge umgedreht', async () => {
    const rows = [
      { role: 'assistant', content: 'Zweite' },
      { role: 'user', content: 'Erste' },
      { role: 'user', content: 'Erste' },
    ];
    const r = await prompt({ merge: { sessionId: 'telegram:1', qualifiedUserId: 'telegram:1', userId: '1', userMessage: 'x', source: 'telegram' }, rows });
    const v = verlauf(r.systemPrompt);
    assert.ok(v.includes('# RECENT CONVERSATION (diese Sitzung, aelteste zuerst)'));
    assert.equal((v.match(/user: Erste/g) || []).length, 1);
    assert.ok(v.indexOf('user: Erste') < v.indexOf('assistant: Zweite'));
  });

  await fall('$now bleibt fuer CURRENT TIME zustaendig, Ausgabefelder unveraendert', async () => {
    const r = await prompt({ merge: PERSON_WEB, rows: ZEILEN });
    assert.ok(r.systemPrompt.startsWith('# CURRENT TIME\n' + NOW_TEXT));
    assert.equal(r.sessionId, 'web:gretel');
    assert.equal(r.qualifiedUserId, 'web:gretel');
    assert.equal(r.userMessage, 'Hi');
  });

  console.log('\n' + (n - fehler) + ' von ' + n + ' Faellen bestanden');
  process.exit(fehler ? 1 : 0);
})();
