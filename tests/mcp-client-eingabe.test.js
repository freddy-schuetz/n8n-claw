// Runde 6 (10.09.2026): der MCP-Client darf nie mehr werfen, wenn das Modell ihn
// ohne Eingabe aufruft (199 ReferenceErrors, eine Anfrage lief zweieinhalb
// Stunden). Dazu die Obergrenze je Anfrage, der Werkzeugnamen-Alias, neue
// Argument-Aliasse und die Hinweise bei Abweisungen. Der ECHTE Code aus den drei
// Workflow-Dateien wird ausgefuehrt, alle HTTP-Aufrufe sind gefaelscht.
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function loadCode(file) {
  const wf = JSON.parse(fs.readFileSync(path.join(REPO, file), 'utf8'));
  const node = wf.nodes.find(n => n.name === 'MCP Client' && (n.parameters || {}).jsCode);
  if (!node) throw new Error('MCP Client in ' + file + ' nicht gefunden');
  return node.parameters.jsCode
    .replace(/\{\{SUPABASE_URL\}\}/g, 'http://stub.local')
    .replace(/\{\{SUPABASE_SERVICE_KEY\}\}/g, 'stub-key');
}

const TOOLS = [
  { name: 'get_page', inputSchema: { type: 'object', properties: { page_id: { type: 'string' }, content_type: { type: 'string' }, format: { type: 'string' } }, required: ['page_id'] }, annotations: { readOnlyHint: true } },
  { name: 'get_page_by_title', inputSchema: { type: 'object', properties: { title: { type: 'string' }, space_id: { type: 'string' }, space_key: { type: 'string' } }, required: ['title'] } },
  { name: 'search_pages', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'string' } }, required: ['query'] } },
  { name: 'update_page', inputSchema: { type: 'object', properties: { page_id: { type: 'string' }, body: { type: 'string' } }, required: ['page_id'] } },
  { name: 'list_comments_on_page', inputSchema: { type: 'object', properties: { page_id: { type: 'string' } }, required: ['page_id'] } },
  { name: 'transition_issue', inputSchema: { type: 'object', properties: { caller: { type: 'string' }, key: { type: 'string' }, transition: { type: 'string' } }, required: ['key', 'transition'] } },
  { name: 'send_teams_message', inputSchema: { type: 'object', properties: { caller: { type: 'string' }, to: { type: 'string' }, text: { type: 'string' }, code: { type: 'string' } }, required: ['to', 'text'] } }
];

function makeHelpers(sink, opts) {
  opts = opts || {};
  return {
    async httpRequest(o) {
      const url = String(o.url || '');
      const body = String(o.body || '');
      if (url.includes('tool_audit_log') && o.method === 'POST') { sink.audit.push(JSON.parse(body)); return {}; }
      if (url.includes('tool_audit_log') && o.method === 'GET') {
        sink.zaehlung = url;
        return Array.from({ length: opts.bisher || 0 }, (_, i) => ({ id: i }));
      }
      if (url.startsWith('http://stub.local')) return url.includes('mcp_registry') ? [] : {};
      if (body.includes('"initialize"')) return { headers: { 'mcp-session-id': 's1' }, body: 'data: {"jsonrpc":"2.0","id":1,"result":{}}' };
      if (body.includes('notifications/initialized')) return '';
      if (body.includes('"tools/list"')) return 'data: ' + JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: TOOLS } });
      if (body.includes('"tools/call"')) {
        const p = JSON.parse(body).params;
        sink.call = { name: p.name, args: p.arguments };
        return { body: 'data: ' + JSON.stringify({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'ERGEBNIS' }] } }) };
      }
      return {};
    }
  };
}

// query === undefined heisst hier: das Argument wird gar nicht uebergeben, so
// dass "query" im Funktionsrumpf undeklariert ist, wie im Werkzeug-Sandkasten.
async function run(file, query, opts) {
  opts = opts || {};
  const sink = { audit: [], call: undefined, zaehlung: undefined };
  const $ = () => ({ first: () => ({ json: { sessionId: 'teams:a:x', qualifiedUserId: 'web:barbara', source: 'teams', display_name: 'Barbara' } }) });
  const params = query === undefined ? ['helpers', '$', '$execution'] : ['query', 'helpers', '$', '$execution'];
  const fn = new AsyncFunction(...params, loadCode(file) + '\n//# sourceURL=mcp-client.js');
  const argv = query === undefined ? [] : [query];
  let out, threw = null;
  try { out = await fn(...argv, makeHelpers(sink, opts), $, { id: 'exec-r6' }); } catch (e) { threw = e; }
  return { out: String(out), threw, sink };
}

let n = 0, f = 0;
function pruefe(name, ok, info) {
  n++; if (!ok) f++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  -> ' + JSON.stringify(info).slice(0, 300)));
}
const AGENT = 'workflows/n8n-claw-agent.json';
const SUB = 'workflows/sub-agent-runner.json';
const BG = 'workflows/background-checker.json';
const CALL = (name, args) => ({ mcp_url: 'https://mcp.example/conf', tool_name: name, arguments: args });

(async () => {
  console.log('--- Eingabe ohne query (der Absturz vom 10.09.) ---');
  for (const file of [AGENT, SUB, BG]) {
    const r = await run(file, undefined);
    pruefe(file + ': wirft nicht mehr', r.threw === null, r.threw && r.threw.message);
    pruefe(file + ': sagt "ohne Eingabe" und protokolliert als rejected',
      /ohne Eingabe/.test(r.out) && r.sink.audit.length === 1 && r.sink.audit[0].status === 'rejected', [r.out.slice(0, 80), r.sink.audit]);
  }
  let r = await run(AGENT, '');
  pruefe('leerer String zaehlt als ohne Eingabe', /ohne Eingabe/.test(r.out) && r.threw === null, r.out.slice(0, 80));
  r = await run(AGENT, 'kein json {');
  pruefe('unlesbares JSON: Meldung statt Absturz, protokolliert', /nicht lesbar/.test(r.out) && r.sink.audit[0].status === 'rejected', r.out.slice(0, 80));
  r = await run(AGENT, { mcp_url: '', tool_name: 'x', arguments: {} });
  pruefe('fehlende mcp_url wird protokolliert abgewiesen', /mcp_url=/.test(r.out) && r.sink.audit.length === 1, r.out.slice(0, 80));

  console.log('--- Obergrenze je Anfrage ---');
  r = await run(AGENT, CALL('get_page', { page_id: '1' }), { bisher: 59 });
  pruefe('59 bisherige Aufrufe: laeuft normal', r.sink.call && r.sink.call.name === 'get_page' && r.out === 'ERGEBNIS', [r.out, r.sink.call]);
  pruefe('Zaehlung fragt nach dieser Execution', /execution_id=eq\.exec-r6/.test(r.sink.zaehlung || ''), r.sink.zaehlung);
  r = await run(AGENT, CALL('get_page', { page_id: '1' }), { bisher: 60 });
  pruefe('60 bisherige Aufrufe: nichts ausgefuehrt, Obergrenze gemeldet', !r.sink.call && /Obergrenze erreicht: 60/.test(r.out), [r.out.slice(0, 80), r.sink.call]);
  pruefe('Obergrenze steht im Protokoll', r.sink.audit.length === 1 && r.sink.audit[0].status === 'rejected' && r.sink.audit[0].execution_id === 'exec-r6', r.sink.audit);
  r = await run(SUB, CALL('get_page', { page_id: '1' }), { bisher: 61 });
  pruefe('Sub-Agent: Obergrenze greift ebenfalls', !r.sink.call && /Obergrenze/.test(r.out), r.out.slice(0, 80));
  r = await run(AGENT, undefined, { bisher: 60 });
  pruefe('leerer Aufruf bei erreichter Obergrenze: Obergrenze wird gemeldet (Schleife aus leeren Aufrufen endet)', /Obergrenze erreicht/.test(r.out) && r.sink.audit[0].status === 'rejected', r.out.slice(0, 80));
  r = await run(AGENT, { mcp_url: '', tool_name: 'x', arguments: {} }, { bisher: 60 });
  pruefe('unvollstaendiger Aufruf zaehlt ebenfalls gegen die Obergrenze', /Obergrenze erreicht/.test(r.out), r.out.slice(0, 80));

  console.log('--- Werkzeugname ---');
  r = await run(AGENT, CALL('list_comments', { page_id: '5' }));
  pruefe('list_comments -> list_comments_on_page (eindeutiger Praefix)', r.sink.call && r.sink.call.name === 'list_comments_on_page' && r.sink.call.args.page_id === '5', r.sink.call);
  pruefe('Protokoll traegt den echten Werkzeugnamen', r.sink.audit[0].tool_name === 'list_comments_on_page', r.sink.audit[0]);
  r = await run(AGENT, CALL('GetPage', { page_id: '5' }));
  pruefe('GetPage -> get_page (normalisiert gleich)', r.sink.call && r.sink.call.name === 'get_page', r.sink.call);
  r = await run(AGENT, CALL('get_pag', { page_id: '5' }));
  pruefe('Praefix ohne Unterstrich (get_pag) wird NICHT geraten', !r.sink.call && /gibt es auf diesem Server nicht/.test(r.out), r.out.slice(0, 120));
  r = await run(AGENT, CALL('delete_everything', {}));
  pruefe('unbekanntes Werkzeug: Liste statt Serverfehler', !r.sink.call && /gibt es auf diesem Server nicht/.test(r.out) && /get_page, get_page_by_title/.test(r.out), r.out.slice(0, 160));
  pruefe('unbekanntes Werkzeug ist protokolliert (rejected)', r.sink.audit.length === 1 && r.sink.audit[0].status === 'rejected', r.sink.audit);

  console.log('--- Argument-Aliasse ---');
  r = await run(AGENT, CALL('transition_issue', { key: 'OM-1', transitionId: '31' }));
  pruefe('transitionId -> transition', r.sink.call && r.sink.call.args.transition === '31' && !('transitionId' in r.sink.call.args), r.sink.call);
  r = await run(AGENT, CALL('transition_issue', { key: 'OM-1', transition_id: '31' }));
  pruefe('transition_id -> transition (Praefixregel bleibt)', r.sink.call && r.sink.call.args.transition === '31', r.sink.call);
  r = await run(AGENT, CALL('search_pages', { cql: 'space = "PRO28"' }));
  pruefe('cql -> query', r.sink.call && r.sink.call.args.query === 'space = "PRO28"' && !('cql' in r.sink.call.args), r.sink.call);
  r = await run(AGENT, CALL('get_page_by_title', { title: 'Rupert', space_key: 'PRO28' }));
  pruefe('space_key bleibt, wenn das Schema es kennt (Confluence 1.7.1)', r.sink.call && r.sink.call.args.space_key === 'PRO28', r.sink.call);

  console.log('--- get_page: Abschnittsargumente fallen weg ---');
  r = await run(AGENT, CALL('get_page', { page_id: '9', offset: 5000, start: 0, expand: 'body' }));
  pruefe('offset/start/expand entfernt, Aufruf laeuft', r.sink.call && r.sink.call.name === 'get_page' && Object.keys(r.sink.call.args).sort().join() === 'page_id', r.sink.call);
  pruefe('Antwort traegt den Hinweis', /ERGEBNIS/.test(r.out) && /offset, start, expand wurde ignoriert/.test(r.out) && /ganze Seite/.test(r.out), r.out);
  r = await run(AGENT, CALL('get_page', { page_id: '9' }));
  pruefe('ohne solche Argumente kein Hinweis', r.out === 'ERGEBNIS', r.out);
  r = await run(AGENT, CALL('search_pages', { query: 'x', offset: 10 }));
  pruefe('offset bei anderen Werkzeugen wird weiter abgewiesen', !r.sink.call && /unknown args \[offset\]/.test(r.out), r.out.slice(0, 100));

  console.log('--- Hinweise bei Abweisungen ---');
  r = await run(AGENT, CALL('update_page', { page_id: '1', find: 'a', replace: 'b' }));
  pruefe('update_page find/replace: Hinweis auf get_page + expected_version', /Hinweis: update_page ersetzt den ganzen Inhalt/.test(r.out) && !r.sink.call, r.out.slice(0, 200));
  r = await run(AGENT, CALL('send_teams_message', { to: 'Hannah', text: 'hi', confirm: true }));
  pruefe('send_teams_message confirm: Hinweis auf code', /Hinweis: Die Bestaetigung laeuft ueber code/.test(r.out), r.out.slice(0, 200));
  r = await run(AGENT, CALL('get_page_by_title', { title: 'x', space: 'PRO28' }));
  pruefe('get_page_by_title space: Hinweis', /Hinweis: get_page_by_title filtert ueber space_key/.test(r.out), r.out.slice(0, 200));
  r = await run(AGENT, CALL('update_page', { page_id: '1', foo: 'x' }));
  pruefe('unbekanntes Argument ohne Hinweis: nur Schema wie bisher', /unknown args \[foo\]/.test(r.out) && !/Hinweis:/.test(r.out), r.out.slice(0, 120));

  console.log('--- Regression ---');
  r = await run(AGENT, CALL('transition_issue', { key: 'OM-1', transition: 'Done', caller: 'web:fremd' }));
  pruefe('caller kommt weiter vom Aufrufer', r.sink.call && r.sink.call.args.caller === 'web:barbara', r.sink.call);
  r = await run(AGENT, JSON.stringify(CALL('get_page', { page_id: '3' })));
  pruefe('String-Eingabe (JSON) funktioniert wie vorher', r.sink.call && r.sink.call.args.page_id === '3' && r.out === 'ERGEBNIS', [r.out, r.sink.call]);

  console.log('\n' + (n - f) + ' von ' + n + ' Faellen bestanden');
  process.exit(f ? 1 : 0);
})();
