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
  { name: 'send_teams_message', inputSchema: { type: 'object', properties: { caller: { type: 'string' }, to: { type: 'string' }, text: { type: 'string' }, code: { type: 'string' } }, required: ['to', 'text'] } },
  // Ab 18.09.2026 fuer die neuen Hinweise: die Werkzeuge liegen live auf anderen
  // Servern, fuer die Argumentpruefung zaehlt aber nur das Schema.
  { name: 'create_draft', inputSchema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['body'] } },
  { name: 'reply_draft', inputSchema: { type: 'object', properties: { message_id: { type: 'string' }, body: { type: 'string' } }, required: ['message_id', 'body'] } },
  { name: 'search_issues', inputSchema: { type: 'object', properties: { jql: { type: 'string' }, limit: { type: 'string' } }, required: ['jql'] } },
  { name: 'list_events', inputSchema: { type: 'object', properties: { start: { type: 'string' }, end: { type: 'string' } }, required: [] } },
  { name: 'get_message', inputSchema: { type: 'object', properties: { message_id: { type: 'string' }, mailbox: { type: 'string' } }, required: ['message_id'] } },
  { name: 'search_messages', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'string' }, folder: { type: 'string' } }, required: [] } },
  { name: 'replace_in_page', inputSchema: { type: 'object', properties: { page_id: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' } }, required: ['page_id', 'find', 'replace'] } },
  { name: 'list_issue_types', inputSchema: { type: 'object', properties: { project_key: { type: 'string' } }, required: ['project_key'] } }
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
  pruefe('get_page_by_title space -> space_key (18.09.: uebersetzen statt abweisen)',
    r.sink.call && r.sink.call.args.space_key === 'PRO28' && !('space' in r.sink.call.args), r.sink.call);
  r = await run(AGENT, CALL('update_page', { page_id: '1', foo: 'x' }));
  pruefe('unbekanntes Argument ohne Hinweis: nur Schema wie bisher', /unknown args \[foo\]/.test(r.out) && !/Hinweis:/.test(r.out), r.out.slice(0, 120));

  console.log('--- Klammer-Reparatur (die 21 Faelle vom 11. bis 17.09.) ---');
  // Echte Rohaufrufe aus den Execution-Snapshots, jeweils ohne die letzte Klammer.
  const OHNE_KLAMMER = [
    ['deploy_meeting_bot', '{\"mcp_url\":\"https://mcp.example/conf\",\"tool_name\":\"get_page\",\"arguments\":{\"page_id\":\"1105199111\",\"format\":\"storage\"}'],
    ['append_to_page', '{\"mcp_url\": \"https://mcp.example/conf\", \"tool_name\": \"search_pages\", \"arguments\": {\"query\": \"Rupert steigt aus dem Call aus, Prioritaet: Hoch\"}'],
    ['replace_in_page mit Maskierung', '{\"mcp_url\": \"https://mcp.example/conf\", \"tool_name\": \"update_page\", \"arguments\": {\"page_id\": \"1102839809\", \"body\": \"Zeile A\\nZeile B mit \\\"Anfuehrung\\\" drin\"}'],
    ['zwei fehlende Klammern', '{\"mcp_url\": \"https://mcp.example/conf\", \"tool_name\": \"search_pages\", \"arguments\": {\"query\": \"x\", \"limit\": {\"tief\": \"1\"']
  ];
  for (const [name, roh] of OHNE_KLAMMER) {
    r = await run(AGENT, roh);
    pruefe('repariert: ' + name, !!r.sink.call && !/nicht lesbar/.test(r.out), [r.out.slice(0, 120), r.sink.call]);
  }
  r = await run(AGENT, OHNE_KLAMMER[0][1]);
  // Der Vermerk steht in args, nicht in einer eigenen Spalte: die gibt es in
  // tool_audit_log nicht, PostgREST haette den ganzen Eintrag verworfen und damit
  // die Obergrenze von 60 Aufrufen ausgehebelt, die die Eintraege zaehlt.
  pruefe('reparierter Aufruf steht als repariert im Protokoll', r.sink.audit[0] && r.sink.audit[0].args._repariert === 'klammer', r.sink.audit[0]);
  pruefe('Protokolleintrag nutzt nur vorhandene Spalten',
    r.sink.audit[0] && Object.keys(r.sink.audit[0]).every(k => ['session_id','user_id','source','origin','server_url','tool_name','is_write','write_source','args','args_truncated','status','result_summary','error','duration_ms','execution_id'].includes(k)),
    r.sink.audit[0] && Object.keys(r.sink.audit[0]));
  pruefe('reparierter Aufruf traegt die richtigen Argumente', r.sink.call && r.sink.call.name === 'get_page' && r.sink.call.args.page_id === '1105199111', r.sink.call);
  r = await run(AGENT, JSON.stringify(CALL('get_page', { page_id: '3' })));
  pruefe('vollstaendiger Aufruf wird nicht als repariert markiert', r.sink.audit[0] && !r.sink.audit[0].args._repariert, r.sink.audit[0]);

  console.log('--- Reparatur fuellt keine Pflichtfelder mehr leer ---');
  // Bricht die Eingabe genau an einer Feldgrenze ab, fehlt ein Pflichtfeld. Frueher
  // wurde es mit '' gefuellt und der Aufruf lief; bei replace_in_page waere damit
  // eine Fundstelle durch nichts ersetzt worden.
  r = await run(AGENT, '{"mcp_url": "https://mcp.example/conf", "tool_name": "replace_in_page", "arguments": {"page_id": "1102839809", "find": "Alter Text"');
  pruefe('repariert, aber Pflichtfeld fehlt: nichts ausgefuehrt',
    !r.sink.call && /fehlende schliessende Klammern/.test(r.out) && /replace/.test(r.out), [r.out.slice(0, 180), r.sink.call]);
  pruefe('die Abweisung steht im Protokoll', r.sink.audit.length === 1 && r.sink.audit[0].status === 'rejected', r.sink.audit);
  r = await run(AGENT, '{"mcp_url": "https://mcp.example/conf", "tool_name": "replace_in_page", "arguments": {"page_id": "1", "find": "a", "replace": "b"');
  pruefe('repariert und vollstaendig: laeuft', r.sink.call && r.sink.call.name === 'replace_in_page' && r.sink.call.args.replace === 'b', r.sink.call);
  r = await run(AGENT, CALL('replace_in_page', { page_id: '1', find: 'a' }));
  pruefe('ohne Reparatur wird weiter leer gefuellt (unveraendert)', r.sink.call && r.sink.call.args.replace === '', r.sink.call);

  console.log('--- in_reply_to landet nie im Empfaengerfeld ---');
  r = await run(AGENT, CALL('create_draft', { to: 'sara@x.at', body: 'Danke', in_reply_to: 'AAMkADA0NWQx' }));
  pruefe('in_reply_to wird nicht auf to gelegt', !r.sink.call && !/AAMkADA0NWQx/.test(JSON.stringify(r.sink.call || {})), r.sink.call);
  pruefe('stattdessen der Hinweis auf reply_draft', /reply_draft/.test(r.out), r.out.slice(0, 200));
  r = await run(AGENT, CALL('create_draft', { to: 'sara@x.at', body: 'Danke' }));
  pruefe('Regression: normaler Entwurf laeuft', r.sink.call && r.sink.call.args.to === 'sara@x.at', r.sink.call);

  console.log('--- Klammer-Reparatur greift NICHT bei echtem Muell ---');
  for (const [name, roh] of [
    ['abgeschnittener Schluessel', '{\"mcp_url\": \"https://mcp.example/conf\", \"tool_na'],
    ['offene Zeichenkette', '{\"mcp_url\": \"https://mcp.example/conf\", \"tool_name\": \"get_pa'],
    ['falsch verschachtelt', '{\"a\": [1, 2}'],
    ['gar kein JSON', 'bitte lies die Seite 123'],
    ['nur ein Wort', 'get_page']
  ]) {
    r = await run(AGENT, roh);
    pruefe('abgewiesen: ' + name, !r.sink.call && /nicht lesbar/.test(r.out) && r.threw === null, [r.out.slice(0, 100), r.sink.call]);
  }
  r = await run(AGENT, 'kein json {');
  pruefe('Abweisung nennt jetzt Fehlerstelle und Ende der Eingabe', /Die Eingabe endet mit: \.\.\./.test(r.out), r.out.slice(0, 200));
  r = await run(AGENT, '{\"a\": [1, 2}');
  pruefe('Abweisung wird protokolliert', r.sink.audit.length === 1 && r.sink.audit[0].status === 'rejected', r.sink.audit);

  console.log('--- Neue Synonyme (12 Abweisungen vom 11. bis 17.09.) ---');
  r = await run(AGENT, CALL('search_pages', { query: 'x', top: 5 }));
  pruefe('top -> limit', r.sink.call && r.sink.call.args.limit === '5' && !('top' in r.sink.call.args), r.sink.call);
  r = await run(AGENT, CALL('replace_in_page', { page_id: '1', old_text: 'alt', new_text: 'neu' }));
  pruefe('old_text/new_text -> find/replace', r.sink.call && r.sink.call.args.find === 'alt' && r.sink.call.args.replace === 'neu'
    && !('old_text' in r.sink.call.args), r.sink.call);
  r = await run(AGENT, CALL('list_issue_types', { projectKey: 'OM' }));
  pruefe('projectKey -> project_key', r.sink.call && r.sink.call.args.project_key === 'OM', r.sink.call);
  r = await run(AGENT, CALL('search_messages', { query: 'x', mail_folder: 'ToDo' }));
  pruefe('mail_folder -> folder', r.sink.call && r.sink.call.args.folder === 'ToDo', r.sink.call);
  r = await run(AGENT, CALL('update_page', { page_id: '1', old_text: 'a' }));
  pruefe('old_text ohne passendes Ziel bleibt eine Abweisung (update_page kennt find nicht)',
    !r.sink.call && /unknown args \[old_text\]/.test(r.out), r.out.slice(0, 120));

  console.log('--- Neue Hinweise ---');
  for (const [tool, args, muster] of [
    ['create_draft', { to: 'a@b.c', reply_to_message_id: 'AAMk' }, /reply_draft/],
    ['search_issues', { jql: 'project = OM', startAt: 50 }, /blaettert nicht/],
    ['list_events', { date: '2026-09-18' }, /Zeitraum/],
    ['get_message', { query: 'Rechnung' }, /search_messages/]
  ]) {
    r = await run(AGENT, CALL(tool, args));
    pruefe('Hinweis fuer ' + tool, muster.test(r.out), r.out.slice(0, 220));
  }

  console.log('--- Regression ---');
  r = await run(AGENT, CALL('transition_issue', { key: 'OM-1', transition: 'Done', caller: 'web:fremd' }));
  pruefe('caller kommt weiter vom Aufrufer', r.sink.call && r.sink.call.args.caller === 'web:barbara', r.sink.call);
  r = await run(AGENT, JSON.stringify(CALL('get_page', { page_id: '3' })));
  pruefe('String-Eingabe (JSON) funktioniert wie vorher', r.sink.call && r.sink.call.args.page_id === '3' && r.out === 'ERGEBNIS', [r.out, r.sink.call]);

  console.log('\n' + (n - f) + ' von ' + n + ' Faellen bestanden');
  process.exit(f ? 1 : 0);
})();
