// Prueft den Knoten "Merge Input" mit dem ECHTEN Code aus der Workflow-Datei:
// historyScope (person/session) und die daraus gebaute WHERE-Klausel.
//   node tests/merge-input-verlauf.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'n8n-claw-agent.json'), 'utf8'));
const code = wf.nodes.find(n => n.name === 'Merge Input').parameters.jsCode;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const merge = new AsyncFunction('$input', code);

async function lauf(json) {
  const [r] = await merge({ first: () => ({ json: Object.assign({}, json) }) });
  return r.json;
}
const PERSON_TAIL = " AND (session_id LIKE 'web:%' OR session_id LIKE 'teams:a:%')";

let n = 0, fehler = 0;
async function fall(name, fn) {
  n++;
  try { await fn(); console.log('PASS', name); }
  catch (e) { fehler++; console.log('FAIL', name, '\n     ', e.message); }
}

(async () => {
  await fall('web:gretel -> person, Filter auf die Person und beide persoenlichen Kanaele', async () => {
    const r = await lauf({ sessionId: 'web:gretel', qualifiedUserId: 'web:gretel', userId: 'web:gretel', userMessage: 'Hi' });
    assert.equal(r.historyScope, 'person');
    assert.equal(r.historyWhere, "user_id = 'web:gretel'" + PERSON_TAIL);
    assert.equal(r.userMessage, 'Hi', 'bestehende Felder bleiben');
  });

  await fall('teams:a:konv1 (persoenlicher Teams-Chat) -> person', async () => {
    const r = await lauf({ sessionId: 'teams:a:konv1', qualifiedUserId: 'entra:1111', userId: 'entra:1111' });
    assert.equal(r.historyScope, 'person');
    assert.equal(r.historyWhere, "user_id = 'entra:1111'" + PERSON_TAIL);
  });

  await fall('teams:19:...@thread.tacv2 (Kanal) -> session', async () => {
    const r = await lauf({ sessionId: 'teams:19:abc123@thread.tacv2', qualifiedUserId: 'entra:1111', userId: 'entra:1111' });
    assert.equal(r.historyScope, 'session');
    assert.equal(r.historyWhere, "session_id = 'teams:19:abc123@thread.tacv2'");
  });

  await fall('teams:19:...@thread.v2 (Gruppenchat) -> session', async () => {
    const r = await lauf({ sessionId: 'teams:19:xyz@thread.v2', qualifiedUserId: 'entra:1111' });
    assert.equal(r.historyScope, 'session');
    assert.equal(r.historyWhere, "session_id = 'teams:19:xyz@thread.v2'");
  });

  await fall('telegram -> session', async () => {
    const r = await lauf({ sessionId: 'telegram:123', qualifiedUserId: 'telegram:456', userId: '456' });
    assert.equal(r.historyScope, 'session');
    assert.equal(r.historyWhere, "session_id = 'telegram:123'");
  });

  await fall('scheduled_task (telegram-Sitzung) -> session', async () => {
    const r = await lauf({ sessionId: 'telegram:123', qualifiedUserId: 'telegram:456', userId: '456', source: 'scheduled_task' });
    assert.equal(r.historyScope, 'session');
  });

  await fall('api-Sitzung ohne web/teams-Praefix -> session', async () => {
    const r = await lauf({ sessionId: 'api:client1', qualifiedUserId: 'api:client1' });
    assert.equal(r.historyScope, 'session');
    assert.equal(r.historyWhere, "session_id = 'api:client1'");
  });

  await fall('Hochkomma in der Kennung wird verdoppelt (person)', async () => {
    const r = await lauf({ sessionId: "web:o'brien", qualifiedUserId: "web:o'brien", userId: "web:o'brien" });
    assert.equal(r.historyWhere, "user_id = 'web:o''brien'" + PERSON_TAIL);
  });

  await fall('Hochkomma in der Sitzung wird verdoppelt (session)', async () => {
    const r = await lauf({ sessionId: "telegram:1'; DROP TABLE x; --", qualifiedUserId: 'telegram:1' });
    assert.equal(r.historyWhere, "session_id = 'telegram:1''; DROP TABLE x; --'");
  });

  await fall('fehlende qualifiedUserId bei web-Sitzung -> session', async () => {
    const r = await lauf({ sessionId: 'web:gast' });
    assert.equal(r.historyScope, 'session');
    assert.equal(r.historyWhere, "session_id = 'web:gast'");
  });

  await fall('fehlende sessionId -> session mit leerem Filterwert, kein Absturz', async () => {
    const r = await lauf({ qualifiedUserId: 'web:gretel' });
    assert.equal(r.historyScope, 'session');
    assert.equal(r.historyWhere, "session_id = ''");
  });

  await fall('rohe userId weicht ab (Client ohne Praefix) -> beide Formen gesucht', async () => {
    const r = await lauf({ sessionId: 'web:gretel', qualifiedUserId: 'web:gretel', userId: 'gretel' });
    assert.equal(r.historyScope, 'person');
    assert.equal(r.historyWhere, "user_id IN ('web:gretel', 'gretel')" + PERSON_TAIL);
  });

  console.log('\n' + (n - fehler) + ' von ' + n + ' Faellen bestanden');
  process.exit(fehler ? 1 : 0);
})();
