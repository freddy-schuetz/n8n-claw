// Prueft die Memory-Governance mit dem ECHTEN Code der vier Memory-Werkzeuge
// aus der Workflow-Datei: Vorschau vor Team-Eintraegen, Eigentum in jedem
// Scope, Admin-Rechte, Audit-Zeilen und die requesting_user-Uebergabe der Suche.
//   node tests/memory-governance.test.js
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

const ICH = { sessionId: 'web:gretel', qualifiedUserId: 'web:gretel', source: 'web' };

// Nachgebaute Datenschnittstelle: antwortet je nach URL, merkt sich alle Aufrufe.
function umgebung(opts = {}) {
  const calls = [];
  const helpers = { httpRequest: async (req) => {
    const url = String(req.url); const m = req.method || 'GET';
    let body = null;
    try { body = req.body ? JSON.parse(req.body) : null; } catch (_e) { body = req.body; }
    calls.push({ m, url, body });
    if (url.includes('/tools_config?')) return [{ enabled: true, config: { provider: 'openai', api_key: 'k' } }];
    if (url.includes('api.openai.com')) return { data: [{ embedding: [0.1, 0.2] }] };
    if (url.includes('/claw_agents?key=eq.memory_admins')) return [{ content: opts.admins || '' }];
    if (url.includes('/rpc/hybrid_search_memory')) return [{ id: 1, content: 'x', scope: 'team', owner_user_id: 'web:hannah' }];
    if (m === 'GET' && url.includes('/memory_long?id=eq.')) return opts.row ? [opts.row] : [];
    if (m === 'POST' && url.includes('/memory_long')) return [{ id: 42 }];
    if (m === 'PATCH' && url.includes('/memory_long')) return { body: [{ id: (opts.row || {}).id }] };
    if (url.includes('/kg_entities')) return [{ id: 7 }];
    return {};
  } };
  const $ = (name) => ({ first: () => {
    if (name === 'Merge Input') { if (opts.identity === null) throw new Error('kein Merge Input'); return { json: opts.identity || ICH }; }
    throw new Error('unbekannter Knoten: ' + name);
  } });
  return { calls, helpers, $, exec: { id: 'exec-1' } };
}
async function werkzeug(node, query, u) {
  const fn = new AsyncFunction('query', 'helpers', '$', '$execution', loadCode(node));
  const out = await fn(typeof query === 'string' ? query : JSON.stringify(query), u.helpers, u.$, u.exec);
  return JSON.parse(out);
}
const nur = (calls, m, teil) => calls.filter(c => c.m === m && c.url.includes(teil));
const audit = (calls, tool) => nur(calls, 'POST', '/tool_audit_log').map(c => c.body).filter(b => b.tool_name === tool);

const EIGEN = { id: 5, scope: 'team', owner_user_id: 'web:gretel', entity_name: 'SLT', metadata: { a: 1 } };
const FREMD = { id: 6, scope: 'team', owner_user_id: 'web:hannah', entity_name: 'SLT', metadata: {} };
const FREMD_PERSONAL = { id: 8, scope: 'personal', owner_user_id: 'web:hannah', entity_name: null, metadata: {} };
const OHNE_OWNER = { id: 7, scope: 'team', owner_user_id: null, entity_name: null, metadata: {} };

let n = 0, fehler = 0;
async function fall(name, fn) {
  n++;
  try { await fn(); console.log('PASS', name); }
  catch (e) { fehler++; console.log('FAIL', name, '\n     ', e.message); }
}

(async () => {
  console.log('--- Memory Save ---');
  await fall('team ohne confirmed -> Vorschau, kein Schreibzugriff, kein Embedding, kein Audit', async () => {
    const u = umgebung();
    const r = await werkzeug('Memory Save', { content: 'Die Pressekonferenz ist am 12.09.', scope: 'team', category: 'project', importance: 7, entity_name: 'SLT' }, u);
    assert.equal(r.status, 'preview');
    assert.equal(r.saved, false);
    assert.equal(r.scope, 'team');
    assert.equal(r.preview, 'Die Pressekonferenz ist am 12.09.');
    assert.equal(r.category, 'project');
    assert.equal(r.importance, 7);
    assert.equal(r.entity_name, 'SLT');
    assert.match(r.next, /confirmed=true/);
    assert.equal(nur(u.calls, 'POST', '/memory_long').length, 0);
    assert.equal(u.calls.filter(c => c.url.includes('tools_config') || c.url.includes('openai')).length, 0);
    assert.equal(nur(u.calls, 'POST', '/tool_audit_log').length, 0);
  });

  await fall('scope fehlt -> gilt als team, ebenfalls Vorschau', async () => {
    const u = umgebung();
    const r = await werkzeug('Memory Save', { content: 'Kein Scope angegeben' }, u);
    assert.equal(r.status, 'preview');
    assert.equal(nur(u.calls, 'POST', '/memory_long').length, 0);
  });

  await fall('team mit confirmed=true -> POST mit scope team und owner_user_id, Audit ok', async () => {
    const u = umgebung();
    const r = await werkzeug('Memory Save', { content: 'Die Pressekonferenz ist am 12.09.', scope: 'team', confirmed: true, tags: ['Press'] }, u);
    assert.equal(r.success, true);
    assert.equal(r.id, 42);
    assert.equal(r.scope, 'team');
    const p = nur(u.calls, 'POST', '/memory_long');
    assert.equal(p.length, 1);
    assert.equal(p[0].body.scope, 'team');
    assert.equal(p[0].body.owner_user_id, 'web:gretel');
    assert.deepEqual(p[0].body.tags, ['press']);
    assert.ok(p[0].body.embedding, 'Embedding wird mitgeschickt');
    const a = audit(u.calls, 'memory_save');
    assert.equal(a.length, 1);
    assert.equal(a[0].status, 'ok');
    assert.equal(a[0].user_id, 'web:gretel');
    assert.equal(a[0].session_id, 'web:gretel');
    assert.equal(a[0].is_write, true);
    assert.equal(a[0].args.scope, 'team');
    assert.equal(a[0].args.id, 42);
  });

  await fall('confirmed als String "true" zaehlt auch', async () => {
    const u = umgebung();
    const r = await werkzeug('Memory Save', { content: 'x', scope: 'team', confirmed: 'true' }, u);
    assert.equal(r.success, true);
    assert.equal(nur(u.calls, 'POST', '/memory_long').length, 1);
  });

  await fall('personal -> sofort gespeichert, ohne confirmed', async () => {
    const u = umgebung();
    const r = await werkzeug('Memory Save', { content: 'Mag keine Emojis', scope: 'personal', category: 'preference' }, u);
    assert.equal(r.success, true);
    assert.equal(r.scope, 'personal');
    const p = nur(u.calls, 'POST', '/memory_long');
    assert.equal(p.length, 1);
    assert.equal(p[0].body.scope, 'personal');
    assert.equal(p[0].body.owner_user_id, 'web:gretel');
    assert.equal(audit(u.calls, 'memory_save').length, 1);
  });

  await fall('Audit-Fehler stoert das Speichern nicht', async () => {
    const u = umgebung();
    const orig = u.helpers.httpRequest;
    u.helpers.httpRequest = async (req) => { if (String(req.url).includes('tool_audit_log')) throw new Error('audit down'); return orig(req); };
    const r = await werkzeug('Memory Save', { content: 'x', scope: 'personal' }, u);
    assert.equal(r.success, true);
  });

  console.log('--- Memory Update ---');
  await fall('eigener Team-Eintrag als Nicht-Admin -> PATCH, Audit ok', async () => {
    const u = umgebung({ row: EIGEN });
    const r = await werkzeug('Memory Update', { id: 5, content: 'Neu', metadata: { b: 2 } }, u);
    assert.equal(r.success, true);
    const p = nur(u.calls, 'PATCH', '/memory_long?id=eq.5');
    assert.equal(p.length, 1);
    assert.equal(p[0].body.content, 'Neu');
    assert.deepEqual(p[0].body.metadata, { a: 1, b: 2 });
    assert.equal(nur(u.calls, 'GET', '/claw_agents').length, 0, 'kein Admin-Lookup bei eigenem Eintrag');
    const a = audit(u.calls, 'memory_update');
    assert.equal(a.length, 1);
    assert.equal(a[0].status, 'ok');
    assert.equal(a[0].args.id, 5);
    assert.equal(a[0].args.content, 'Neu');
  });

  await fall('fremder Eintrag als Nicht-Admin -> Fehler, kein PATCH, Audit rejected', async () => {
    const u = umgebung({ row: FREMD });
    const r = await werkzeug('Memory Update', { id: 6, content: 'Neu' }, u);
    assert.match(r.error, /^Nicht erlaubt: Diesen Eintrag hat jemand anderes angelegt/);
    assert.equal(r.scope, 'team');
    assert.equal(r.owner_user_id, 'web:hannah');
    assert.equal(nur(u.calls, 'PATCH', '/memory_long').length, 0);
    const a = audit(u.calls, 'memory_update');
    assert.equal(a.length, 1);
    assert.equal(a[0].status, 'rejected');
  });

  await fall('fremder persoenlicher Eintrag als Nicht-Admin -> Fehler', async () => {
    const u = umgebung({ row: FREMD_PERSONAL });
    const r = await werkzeug('Memory Update', { id: 8, content: 'Neu' }, u);
    assert.match(r.error, /^Nicht erlaubt/);
    assert.equal(r.scope, 'personal');
    assert.equal(nur(u.calls, 'PATCH', '/memory_long').length, 0);
  });

  await fall('fremder Eintrag als Admin -> PATCH', async () => {
    const u = umgebung({ row: FREMD, admins: 'telegram:123, web:gretel' });
    const r = await werkzeug('Memory Update', { id: 6, importance: 9 }, u);
    assert.equal(r.success, true);
    assert.equal(nur(u.calls, 'PATCH', '/memory_long?id=eq.6').length, 1);
  });

  await fall('Admin-Muster mit Praefix (web:*) gilt', async () => {
    const u = umgebung({ row: FREMD, admins: 'web:*' });
    const r = await werkzeug('Memory Update', { id: 6, importance: 9 }, u);
    assert.equal(r.success, true);
  });

  await fall('Eintrag ohne owner_user_id ist nicht "eigen" -> nur Admins', async () => {
    const u = umgebung({ row: OHNE_OWNER });
    const r = await werkzeug('Memory Update', { id: 7, importance: 9 }, u);
    assert.match(r.error, /^Nicht erlaubt/);
    assert.equal(r.owner_user_id, null);
  });

  await fall('unbekannte id -> not found, kein Audit', async () => {
    const u = umgebung({ row: null });
    const r = await werkzeug('Memory Update', { id: 99, importance: 9 }, u);
    assert.match(r.error, /not found/);
    assert.equal(nur(u.calls, 'POST', '/tool_audit_log').length, 0);
  });

  console.log('--- Memory Delete ---');
  await fall('eigener Team-Eintrag als Nicht-Admin -> DELETE, Audit ok', async () => {
    const u = umgebung({ row: EIGEN });
    const r = await werkzeug('Memory Delete', { id: 5 }, u);
    assert.equal(r.success, true);
    assert.equal(r.deleted_id, 5);
    assert.equal(r.entity_forgotten, false);
    assert.equal(nur(u.calls, 'DELETE', '/memory_long?id=eq.5').length, 1);
    assert.equal(nur(u.calls, 'GET', '/claw_agents').length, 0, 'kein Admin-Lookup bei eigenem Eintrag');
    const a = audit(u.calls, 'memory_delete');
    assert.equal(a.length, 1);
    assert.equal(a[0].status, 'ok');
    assert.equal(a[0].args.id, 5);
  });

  await fall('fremder Eintrag als Nicht-Admin -> Fehler, kein DELETE, Audit rejected', async () => {
    const u = umgebung({ row: FREMD });
    const r = await werkzeug('Memory Delete', { id: 6 }, u);
    assert.match(r.error, /^Nicht erlaubt: Diesen Eintrag hat jemand anderes angelegt/);
    assert.equal(r.scope, 'team');
    assert.equal(r.owner_user_id, 'web:hannah');
    assert.equal(nur(u.calls, 'DELETE', '/memory_long').length, 0);
    assert.equal(audit(u.calls, 'memory_delete')[0].status, 'rejected');
  });

  await fall('fremder Eintrag als Admin -> DELETE', async () => {
    const u = umgebung({ row: FREMD, admins: 'web:gretel' });
    const r = await werkzeug('Memory Delete', { id: 6 }, u);
    assert.equal(r.success, true);
    assert.equal(nur(u.calls, 'DELETE', '/memory_long?id=eq.6').length, 1);
  });

  await fall('forget_entity als Nicht-Admin auf eigenem Eintrag -> Eintrag weg, keine Kaskade, Hinweis', async () => {
    const u = umgebung({ row: EIGEN });
    const r = await werkzeug('Memory Delete', { id: 5, forget_entity: true }, u);
    assert.equal(r.success, true);
    assert.equal(r.entity_forgotten, false);
    assert.match(r.note || '', /memory admins/);
    assert.equal(nur(u.calls, 'DELETE', '/memory_long?id=eq.5').length, 1);
    assert.equal(nur(u.calls, 'DELETE', '/kg_').length, 0);
  });

  await fall('forget_entity als Admin -> Kaskade auf kg_relations und kg_entities', async () => {
    const u = umgebung({ row: EIGEN, admins: 'web:gretel' });
    const r = await werkzeug('Memory Delete', { id: 5, forget_entity: true }, u);
    assert.equal(r.entity_forgotten, true);
    assert.equal(nur(u.calls, 'DELETE', '/kg_relations').length, 1);
    assert.equal(nur(u.calls, 'DELETE', '/kg_entities?id=eq.7').length, 1);
    assert.equal(audit(u.calls, 'memory_delete')[0].args.entity_forgotten, true);
  });

  await fall('ohne Identitaet (kein Merge Input) -> fremder Eintrag abgewiesen', async () => {
    const u = umgebung({ row: FREMD, identity: null });
    const r = await werkzeug('Memory Delete', { id: 6 }, u);
    assert.match(r.error, /^Nicht erlaubt/);
    assert.equal(nur(u.calls, 'DELETE', '/memory_long').length, 0);
  });

  console.log('--- Memory Search ---');
  await fall('Suche uebergibt requesting_user und reicht scope/owner durch', async () => {
    const u = umgebung();
    const r = await werkzeug('Memory Search', 'Pressekonferenz', u);
    const rpc = nur(u.calls, 'POST', '/rpc/hybrid_search_memory');
    assert.equal(rpc.length, 1);
    assert.equal(rpc[0].body.requesting_user, 'web:gretel');
    assert.equal(rpc[0].body.query_text, 'Pressekonferenz');
    assert.equal(r[0].scope, 'team');
    assert.equal(r[0].owner_user_id, 'web:hannah');
  });

  await fall('Beschreibungen: Suche nennt scope/owner, Save nennt confirmed, keine geschweiften Klammern neu', async () => {
    const d = name => wf.nodes.find(x => x.name === name).parameters.description;
    assert.match(d('Memory Search'), /owner_user_id \(who saved it/);
    assert.match(d('Memory Save'), /confirmed=true only after an explicit yes/);
    assert.match(d('Memory Update'), /own entries \(owner_user_id = you\)/);
    assert.match(d('Memory Delete'), /forget_entity is admin-only/);
    assert.ok(!/[{}]/.test(d('Memory Save')) && !/[{}]/.test(d('Memory Delete')), 'Save/Delete ohne geschweifte Klammern');
  });

  console.log('\n' + (n - fehler) + ' von ' + n + ' Faellen bestanden');
  process.exit(fehler ? 1 : 0);
})();
