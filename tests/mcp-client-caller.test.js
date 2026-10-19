// Prueft die caller-Injektion im MCP-Client, indem der ECHTE Code aus der
// Workflow-Datei ausgefuehrt wird. Alle HTTP-Aufrufe sind gefaelscht, der
// tools/call-Rumpf wird abgefangen und geprueft.
const fs = require('fs');

const path = require('path');
const REPO = path.join(__dirname, '..');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function loadCode(file, nodeName) {
  const wf = JSON.parse(fs.readFileSync(path.join(REPO, file), 'utf8'));
  const node = wf.nodes.find(n => n.name === nodeName && (n.parameters || {}).jsCode);
  if (!node) throw new Error(`Node ${nodeName} in ${file} nicht gefunden`);
  return node.parameters.jsCode
    .replace(/\{\{SUPABASE_URL\}\}/g, 'http://stub.local')
    .replace(/\{\{SUPABASE_SERVICE_KEY\}\}/g, 'stub-key');
}

function makeHelpers(schema, sink) {
  return {
    async httpRequest(opts) {
      const url = String(opts.url || '');
      const body = String(opts.body || '');
      if (url.includes('tool_audit_log')) { sink.audit = JSON.parse(body); return {}; }
      if (url.startsWith('http://stub.local')) return url.includes('mcp_registry') ? [] : {};
      if (body.includes('"initialize"')) {
        return { headers: { 'mcp-session-id': 'sess-1' }, body: 'data: {"jsonrpc":"2.0","id":1,"result":{}}' };
      }
      if (body.includes('notifications/initialized')) return '';
      if (body.includes('"tools/list"')) {
        return 'data: ' + JSON.stringify({
          jsonrpc: '2.0', id: 2,
          result: { tools: [{ name: 'create_event', inputSchema: schema, annotations: { readOnlyHint: false } }] }
        });
      }
      if (body.includes('"tools/call"')) {
        sink.sent = JSON.parse(body).params.arguments;
        return { body: 'data: ' + JSON.stringify({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'OK' }] } }) };
      }
      return {};
    }
  };
}

async function run({ file, node, schema, modelArgs, identity, profile, roh }) {
  const sink = [];
  sink.sent = undefined; sink.audit = undefined;
  const $ = (name) => ({
    first: () => {
      if (name === 'Load User Profile') {
        if (profile === undefined) throw new Error('kein Load User Profile');
        return { json: profile };
      }
      if (identity === undefined) throw new Error('kein Merge Input');
      return { json: identity };
    }
  });
  const fn = new AsyncFunction('query', 'helpers', '$', '$execution',
    loadCode(file, node) + '\n//# sourceURL=mcp-client.js');
  const out = await fn(
    roh !== undefined ? roh : { mcp_url: 'https://mcp.example/test', tool_name: 'create_event', arguments: modelArgs },
    makeHelpers(schema, sink), $, { id: 'exec-1' }
  );
  return { sent: sink.sent, audit: sink.audit, out: String(out) };
}

const SCHEMA_MIT_CALLER = {
  type: 'object',
  properties: { subject: { type: 'string' }, caller: { type: 'string' } },
  required: ['subject', 'caller']
};
const SCHEMA_OHNE_CALLER = {
  type: 'object',
  properties: { subject: { type: 'string' } },
  required: ['subject']
};
const ICH = { sessionId: 'web:gretel', qualifiedUserId: 'entra:95625b4e', source: 'web' };

const AGENT = { file: 'workflows/n8n-claw-agent.json', node: 'MCP Client' };
const SUB = { file: 'workflows/sub-agent-runner.json', node: 'MCP Client' };

let fails = 0;
function pruefe(name, bedingung, detail) {
  const ok = !!bedingung;
  if (!ok) fails++;
  console.log((ok ? '  OK   ' : '  FEHL ') + name + (ok ? '' : '   -> ' + JSON.stringify(detail)));
}

(async () => {
  console.log('--- Agent ---');

  let r = await run({ ...AGENT, schema: SCHEMA_MIT_CALLER, identity: ICH,
    modelArgs: { subject: 'Termin', caller: 'entra:FREMDE-PERSON' } });
  pruefe('Modellwert wird ueberschrieben', r.sent && r.sent.caller === 'entra:95625b4e', r.sent);

  r = await run({ ...AGENT, schema: SCHEMA_MIT_CALLER, identity: ICH, modelArgs: { subject: 'Termin' } });
  pruefe('caller wird gesetzt, wenn das Modell ihn weglaesst', r.sent && r.sent.caller === 'entra:95625b4e', r.sent);

  r = await run({ ...AGENT, schema: SCHEMA_OHNE_CALLER, identity: ICH, modelArgs: { subject: 'Termin' } });
  pruefe('Werkzeug ohne caller bleibt unveraendert', r.sent && !('caller' in r.sent), r.sent);

  r = await run({ ...AGENT, schema: SCHEMA_MIT_CALLER, identity: undefined, modelArgs: { subject: 'Termin', caller: 'entra:FREMDE-PERSON' } });
  pruefe('ohne Identitaet bleibt caller leer', r.sent && r.sent.caller === '', r.sent);

  r = await run({ ...AGENT, schema: SCHEMA_OHNE_CALLER, identity: ICH, modelArgs: { subject: 'Termin', caller: 'entra:FREMDE-PERSON' } });
  pruefe('Regression: unbekanntes Argument wird weiter abgewiesen', r.sent === undefined && /unknown args/.test(r.out), r.out.slice(0, 120));

  r = await run({ ...AGENT, schema: SCHEMA_MIT_CALLER, identity: ICH,
    modelArgs: { subject: 'Termin', caller: 'entra:FREMDE-PERSON' } });
  pruefe('Protokoll zeigt den gesendeten caller, nicht den des Modells',
    r.audit && r.audit.args && r.audit.args.caller === 'entra:95625b4e', r.audit && r.audit.args);

  console.log('--- Alias-Toleranz ---');
  const SCHEMA_MAIL = { type: 'object', properties: { caller: { type: 'string' }, message_id: { type: 'string' } }, required: ['caller', 'message_id'] };
  r = await run({ ...AGENT, schema: SCHEMA_MAIL, identity: ICH, modelArgs: { id: 'AAMk123' } });
  pruefe('id wird zu message_id', r.sent && r.sent.message_id === 'AAMk123' && !('id' in r.sent), r.sent);

  r = await run({ ...AGENT, schema: SCHEMA_MAIL, identity: ICH, modelArgs: { user: 'web:hannah', message_id: 'AAMk123' } });
  pruefe('user faellt weg, caller kommt vom Aufrufer', r.sent && !('user' in r.sent) && r.sent.caller === 'entra:95625b4e', r.sent);

  const SCHEMA_CONFIRM = { type: 'object', properties: { caller: { type: 'string' }, subject: { type: 'string' }, confirm: { type: 'string' } }, required: ['caller', 'subject'] };
  r = await run({ ...AGENT, schema: SCHEMA_CONFIRM, identity: ICH, modelArgs: { subject: 'Termin', confirm_invites: 'true' } });
  pruefe('confirm_invites wird zu confirm', r.sent && r.sent.confirm === 'true' && !('confirm_invites' in r.sent), r.sent);

  const SCHEMA_VEXA = { type: 'object', properties: { vexa_run_id: { type: 'string' } }, required: [] };
  r = await run({ ...AGENT, schema: SCHEMA_VEXA, identity: ICH, modelArgs: { run_id: 26409 } });
  pruefe('run_id wird zu vexa_run_id (und zum String)', r.sent && r.sent.vexa_run_id === '26409', r.sent);

  const SCHEMA_ZWEI = { type: 'object', properties: { event_id: { type: 'string' }, message_id: { type: 'string' } }, required: [] };
  r = await run({ ...AGENT, schema: SCHEMA_ZWEI, identity: ICH, modelArgs: { id: 'x' } });
  pruefe('zwei Kandidaten: weiter abweisen', r.sent === undefined && /unknown args \[id\]/.test(r.out), r.out.slice(0, 120));

  r = await run({ ...AGENT, schema: SCHEMA_MAIL, identity: ICH, modelArgs: { id: 'neu', message_id: 'alt' } });
  pruefe('Zielfeld schon gefuellt: keine Umbenennung, Abweisung', r.sent === undefined && /unknown args \[id\]/.test(r.out), r.out.slice(0, 120));

  r = await run({ ...AGENT, schema: SCHEMA_MAIL, identity: ICH, modelArgs: { range: 'week', message_id: 'x' } });
  pruefe('fremdes Feld ohne Kandidat: weiter abweisen', r.sent === undefined && /unknown args \[range\]/.test(r.out), r.out.slice(0, 120));

  console.log('--- Alias v2 ---');
  const SCHEMA_JIRA = { type: 'object', properties: { key: { type: 'string' }, issuetype: { type: 'string' }, assignee: { type: 'string' }, description: { type: 'string' }, max_results: { type: 'string' }, text: { type: 'string' } }, required: [] };
  r = await run({ ...AGENT, schema: SCHEMA_JIRA, identity: ICH, modelArgs: { key: 'OM-1', issue_type: 'Task' } });
  pruefe('issue_type wird zu issuetype (normalisiert)', r.sent && r.sent.issuetype === 'Task' && !('issue_type' in r.sent), r.sent);

  r = await run({ ...AGENT, schema: SCHEMA_JIRA, identity: ICH, modelArgs: { key: 'OM-1', maxResults: 5 } });
  pruefe('maxResults wird zu max_results (normalisiert, String)', r.sent && r.sent.max_results === '5', r.sent);

  const SCHEMA_LIMIT = { type: 'object', properties: { jql: { type: 'string' }, limit: { type: 'string' } }, required: [] };
  r = await run({ ...AGENT, schema: SCHEMA_LIMIT, identity: ICH, modelArgs: { jql: 'x', maxResults: 20 } });
  pruefe('maxResults wird zu limit (Synonym)', r.sent && r.sent.limit === '20', r.sent);

  r = await run({ ...AGENT, schema: SCHEMA_JIRA, identity: ICH, modelArgs: { key: 'OM-1', body: 'Nein' } });
  pruefe('body wird zu text (Synonym)', r.sent && r.sent.text === 'Nein' && !('body' in r.sent), r.sent);

  r = await run({ ...AGENT, schema: SCHEMA_JIRA, identity: ICH, modelArgs: { id: 'OM-1' } });
  pruefe('id wird zu key (Synonym, kein Praefix-Kandidat)', r.sent && r.sent.key === 'OM-1', r.sent);

  r = await run({ ...AGENT, schema: SCHEMA_JIRA, identity: ICH, modelArgs: { key: 'OM-1', fields: { assignee: 'acc-1', description: 'Neu' } } });
  pruefe('fields-Objekt wird hochgehoben', r.sent && r.sent.assignee === 'acc-1' && r.sent.description === 'Neu' && !('fields' in r.sent), r.sent);

  const SCHEMA_JIRA_CALLER = { type: 'object', properties: { caller: { type: 'string' }, key: { type: 'string' }, assignee: { type: 'string' } }, required: [] };
  r = await run({ ...AGENT, schema: SCHEMA_JIRA_CALLER, identity: ICH, modelArgs: { key: 'OM-1', fields: { assignee: 'acc-1', caller: 'entra:FREMD' } } });
  pruefe('Hochheben ueberspringt caller, Aufrufer setzt ihn', r.sent && r.sent.assignee === 'acc-1' && r.sent.caller === 'entra:95625b4e', r.sent);

  r = await run({ ...AGENT, schema: SCHEMA_JIRA, identity: ICH, modelArgs: { key: 'OM-1', fields: { assignee: 'acc-1', foo: 'x' } } });
  pruefe('Objekt mit fremdem Schluessel bleibt Abweisung', r.sent === undefined && /unknown args \[fields\]/.test(r.out), r.out.slice(0, 120));

  r = await run({ ...SUB, schema: SCHEMA_JIRA, identity: ICH, modelArgs: { key: 'OM-1', issue_type: 'Task' } });
  pruefe('Sub-Agent: issue_type normalisiert', r.sent && r.sent.issuetype === 'Task', r.sent);

  console.log('--- Alias v3 ---');
  r = await run({ ...AGENT, schema: SCHEMA_JIRA, identity: ICH, modelArgs: { issueKey: 'OM-1' } });
  pruefe('issueKey wird zu key', r.sent && r.sent.key === 'OM-1' && !('issueKey' in r.sent), r.sent);

  r = await run({ ...AGENT, schema: SCHEMA_JIRA, identity: ICH, modelArgs: { ticket: 'OM-2' } });
  pruefe('ticket wird zu key', r.sent && r.sent.key === 'OM-2', r.sent);

  const SCHEMA_TO = { type: 'object', properties: { caller: { type: 'string' }, to: { type: 'string' }, subject: { type: 'string' } }, required: ['caller', 'to'] };
  r = await run({ ...AGENT, schema: SCHEMA_TO, identity: ICH, modelArgs: { recipient_email: 'a@b.at', subject: 'Hi' } });
  pruefe('recipient_email wird zu to', r.sent && r.sent.to === 'a@b.at' && !('recipient_email' in r.sent), r.sent);

  const SCHEMA_DUE = { type: 'object', properties: { key: { type: 'string' }, duedate: { type: 'string' } }, required: [] };
  r = await run({ ...AGENT, schema: SCHEMA_DUE, identity: ICH, modelArgs: { key: 'OM-1', due: '2026-09-10' } });
  pruefe('due wird zu duedate (wenn erlaubt)', r.sent && r.sent.duedate === '2026-09-10' && !('due' in r.sent), r.sent);

  r = await run({ ...AGENT, schema: SCHEMA_DUE, identity: ICH, modelArgs: { key: 'OM-1', due_date: '2026-09-11' } });
  pruefe('due_date wird zu duedate (normalisiert)', r.sent && r.sent.duedate === '2026-09-11', r.sent);

  r = await run({ ...AGENT, schema: SCHEMA_JIRA, identity: ICH, modelArgs: { key: 'OM-1', due: '2026-09-10' } });
  pruefe('due ohne Zielfeld bleibt Abweisung', r.sent === undefined && /unknown args \[due\]/.test(r.out), r.out.slice(0, 120));

  r = await run({ ...AGENT, schema: SCHEMA_TO, identity: ICH, modelArgs: { to: 'a@b.at', from_display: 'Gretel', sender: 'x', from: 'y' } });
  pruefe('from_display/sender/from werden verworfen, caller kommt vom Aufrufer', r.sent && !('from_display' in r.sent) && !('sender' in r.sent) && !('from' in r.sent) && r.sent.caller === 'entra:95625b4e', r.sent);

  const SCHEMA_OHNE_CALLER_TO = { type: 'object', properties: { to: { type: 'string' } }, required: [] };
  r = await run({ ...AGENT, schema: SCHEMA_OHNE_CALLER_TO, identity: ICH, modelArgs: { to: 'a@b.at', from_display: 'Gretel' } });
  pruefe('ohne caller im Schema bleibt from_display eine Abweisung', r.sent === undefined && /unknown args \[from_display\]/.test(r.out), r.out.slice(0, 120));

  r = await run({ ...AGENT, schema: SCHEMA_JIRA, identity: ICH, modelArgs: { key: 'OM-1', fields: '{"assignee":"acc-1","description":"Neu"}' } });
  pruefe('fields als JSON-String wird ausgepackt', r.sent && r.sent.assignee === 'acc-1' && r.sent.description === 'Neu' && !('fields' in r.sent), r.sent);

  r = await run({ ...AGENT, schema: SCHEMA_JIRA, identity: ICH, modelArgs: { key: 'OM-1', fields: '{kaputt' } });
  pruefe('kaputter JSON-String bleibt Abweisung', r.sent === undefined && /unknown args \[fields\]/.test(r.out), r.out.slice(0, 120));

  const PROFIL = { display_name: 'Gretel Muster', timezone: 'Europe/Vienna' };
  const SCHEMA_NAME = { type: 'object', properties: { caller: { type: 'string' }, caller_name: { type: 'string' }, subject: { type: 'string' } }, required: ['caller'] };
  r = await run({ ...AGENT, schema: SCHEMA_NAME, identity: ICH, profile: PROFIL, modelArgs: { subject: 'Termin', caller_name: 'Falscher Name' } });
  pruefe('caller_name aus dem Profil, Modellwert ueberschrieben', r.sent && r.sent.caller_name === 'Gretel Muster' && r.sent.caller === 'entra:95625b4e', r.sent);

  r = await run({ ...AGENT, schema: SCHEMA_MIT_CALLER, identity: ICH, profile: PROFIL, modelArgs: { subject: 'Termin' } });
  pruefe('caller_name nicht gesetzt, wenn das Schema es nicht kennt', r.sent && !('caller_name' in r.sent), r.sent);

  r = await run({ ...AGENT, schema: SCHEMA_NAME, identity: ICH, modelArgs: { subject: 'Termin' } });
  pruefe('ohne Profil-Knoten bleibt caller_name leer', r.sent && r.sent.caller_name === '', r.sent);

  r = await run({ ...SUB, schema: SCHEMA_NAME, identity: ICH, modelArgs: { subject: 'Termin', caller_name: 'Falscher Name' } });
  pruefe('Sub-Agent: caller und caller_name leer', r.sent && r.sent.caller === '' && r.sent.caller_name === '', r.sent);

  r = await run({ ...SUB, schema: SCHEMA_TO, identity: ICH, modelArgs: { recipient_email: 'a@b.at', from_display: 'X' } });
  pruefe('Sub-Agent: recipient_email zu to, from_display verworfen', r.sent && r.sent.to === 'a@b.at' && !('from_display' in r.sent), r.sent);

  console.log('--- Sub-Agent ---');
  r = await run({ ...SUB, schema: SCHEMA_MIT_CALLER, identity: ICH, modelArgs: { subject: 'Termin', caller: 'entra:FREMDE-PERSON' } });
  pruefe('Sub-Agent sendet leeren caller', r.sent && r.sent.caller === '', r.sent);

  r = await run({ ...SUB, schema: SCHEMA_MAIL, identity: ICH, modelArgs: { id: 'AAMk123' } });
  pruefe('Sub-Agent: id wird zu message_id', r.sent && r.sent.message_id === 'AAMk123', r.sent);

  const BG = { file: 'workflows/background-checker.json', node: 'MCP Client' };
  r = await run({ ...BG, schema: SCHEMA_MAIL, identity: ICH, modelArgs: { id: 'AAMk123' } });
  pruefe('Background Checker: id wird zu message_id, caller leer', r.sent && r.sent.message_id === 'AAMk123' && r.sent.caller === '', r.sent);

  // Runde 9 (19.10.2026): n8n sperrt seit 2.35.4 den $fromAI-Schluessel "caller",
  // die Skills fragen die Kennung als "callerid" ab. Der Client muss sie dort
  // setzen, alte Namen vom Modell verwerfen, und die Alias-Regel darf "id"
  // weiter eindeutig zuordnen (mit "caller_id" waere das gebrochen).
  console.log('--- callerid (Runde 9) ---');
  const S_ID = { type: 'object', properties: { subject: { type: 'string' }, callerid: { type: 'string' } }, required: ['subject', 'callerid'] };
  r = await run({ ...AGENT, schema: S_ID, identity: ICH, modelArgs: { subject: 'Termin' } });
  pruefe('callerid wird gesetzt, wenn das Modell ihn weglaesst', r.sent && r.sent.callerid === 'entra:95625b4e' && !('caller' in r.sent), r.sent);

  r = await run({ ...AGENT, schema: S_ID, identity: ICH, modelArgs: { subject: 'Termin', callerid: 'entra:FREMDE-PERSON' } });
  pruefe('callerid vom Modell wird ueberschrieben', r.sent && r.sent.callerid === 'entra:95625b4e', r.sent);

  r = await run({ ...AGENT, schema: S_ID, identity: ICH, modelArgs: { subject: 'Termin', caller: 'entra:FREMDE-PERSON' } });
  pruefe('alter Name caller vom Modell faellt weg, keine Abweisung', r.sent && r.sent.callerid === 'entra:95625b4e' && !('caller' in r.sent), r.sent || r.out.slice(0, 120));

  r = await run({ ...AGENT, schema: S_ID, identity: ICH, modelArgs: { subject: 'Termin', caller_id: 'entra:FREMDE-PERSON' } });
  pruefe('caller_id vom Modell faellt weg', r.sent && r.sent.callerid === 'entra:95625b4e' && !('caller_id' in r.sent), r.sent || r.out.slice(0, 120));

  r = await run({ ...AGENT, schema: S_ID, identity: ICH, modelArgs: { subject: 'Termin', caller: 'entra:FREMDE-PERSON' } });
  pruefe('Protokoll zeigt den gesendeten callerid', r.audit && r.audit.args && r.audit.args.callerid === 'entra:95625b4e' && !('caller' in r.audit.args), r.audit && r.audit.args);

  const S_ID_MAIL = { type: 'object', properties: { callerid: { type: 'string' }, message_id: { type: 'string' } }, required: ['callerid', 'message_id'] };
  r = await run({ ...AGENT, schema: S_ID_MAIL, identity: ICH, modelArgs: { id: 'AAMk123' } });
  pruefe('mit callerid: id wird weiter zu message_id', r.sent && r.sent.message_id === 'AAMk123' && !('id' in r.sent) && r.sent.callerid === 'entra:95625b4e', r.sent || r.out.slice(0, 120));

  const S_ID_EVENT = { type: 'object', properties: { callerid: { type: 'string' }, event_id: { type: 'string' } }, required: ['callerid'] };
  r = await run({ ...AGENT, schema: S_ID_EVENT, identity: ICH, modelArgs: { id: 'EV-1' } });
  pruefe('mit callerid: id wird zu event_id', r.sent && r.sent.event_id === 'EV-1', r.sent || r.out.slice(0, 120));

  r = await run({ ...AGENT, schema: S_ID_MAIL, identity: ICH, modelArgs: { user: 'web:hannah', message_id: 'AAMk123' } });
  pruefe('mit callerid: user faellt weg', r.sent && !('user' in r.sent) && r.sent.callerid === 'entra:95625b4e', r.sent);

  const S_ID_TO = { type: 'object', properties: { callerid: { type: 'string' }, to: { type: 'string' }, subject: { type: 'string' } }, required: ['callerid', 'to'] };
  r = await run({ ...AGENT, schema: S_ID_TO, identity: ICH, modelArgs: { to: 'a@b.at', from_display: 'Gretel', sender: 'x', from: 'y' } });
  pruefe('mit callerid: Absenderfelder werden verworfen', r.sent && !('from_display' in r.sent) && !('sender' in r.sent) && !('from' in r.sent) && r.sent.callerid === 'entra:95625b4e', r.sent);

  const S_ID_NAME = { type: 'object', properties: { callerid: { type: 'string' }, caller_name: { type: 'string' }, subject: { type: 'string' } }, required: ['callerid'] };
  r = await run({ ...AGENT, schema: S_ID_NAME, identity: ICH, profile: PROFIL, modelArgs: { subject: 'Termin', caller_name: 'Falscher Name' } });
  pruefe('mit callerid: caller_name aus dem Profil', r.sent && r.sent.caller_name === 'Gretel Muster' && r.sent.callerid === 'entra:95625b4e', r.sent);

  const S_ID_JIRA = { type: 'object', properties: { callerid: { type: 'string' }, key: { type: 'string' }, assignee: { type: 'string' } }, required: [] };
  r = await run({ ...AGENT, schema: S_ID_JIRA, identity: ICH, modelArgs: { key: 'OM-1', fields: { assignee: 'acc-1', caller: 'entra:FREMD' } } });
  pruefe('mit callerid: Hochheben ueberspringt caller', r.sent && r.sent.assignee === 'acc-1' && r.sent.callerid === 'entra:95625b4e' && !('caller' in r.sent), r.sent || r.out.slice(0, 120));

  r = await run({ ...AGENT, schema: SCHEMA_OHNE_CALLER, identity: ICH, modelArgs: { subject: 'Termin', callerid: 'entra:FREMDE-PERSON' } });
  pruefe('ohne Kennungsfeld bleibt callerid eine Abweisung', r.sent === undefined && /unknown args \[callerid\]/.test(r.out), r.out.slice(0, 120));

  r = await run({ ...SUB, schema: S_ID, identity: ICH, modelArgs: { subject: 'Termin', caller: 'entra:FREMDE-PERSON' } });
  pruefe('Sub-Agent: callerid leer, caller faellt weg', r.sent && r.sent.callerid === '' && !('caller' in r.sent), r.sent || r.out.slice(0, 120));

  r = await run({ ...BG, schema: S_ID_MAIL, identity: ICH, modelArgs: { id: 'AAMk123' } });
  pruefe('Background Checker: mit callerid id zu message_id, callerid leer', r.sent && r.sent.message_id === 'AAMk123' && r.sent.callerid === '', r.sent || r.out.slice(0, 120));

  // Nachtrag nach der Durchsicht (19.10.2026): genau die Faelle, an denen eine
  // Regression der Umbenennung sonst unbemerkt durchginge.
  console.log('--- callerid: Durchsicht ---');
  for (const [WO, name] of [[SUB, 'Sub-Agent'], [BG, 'Background Checker']]) {
    r = await run({ ...WO, schema: S_ID, identity: ICH, modelArgs: { subject: 'Termin', callerid: 'entra:FREMDE-PERSON' } });
    pruefe(name + ': callerid vom Modell wird geleert', r.sent && r.sent.callerid === '', r.sent || r.out.slice(0, 120));
    r = await run({ ...WO, schema: S_ID_JIRA, identity: ICH, modelArgs: { key: 'OM-1', fields: { assignee: 'acc-1', callerid: 'entra:FREMD' } } });
    pruefe(name + ': callerid im verpackten Objekt wird nicht uebernommen', r.sent && r.sent.callerid === '' && r.sent.assignee === 'acc-1', r.sent || r.out.slice(0, 120));
    r = await run({ ...WO, schema: SCHEMA_MIT_CALLER, identity: ICH, modelArgs: { subject: 'Termin', callerid: 'entra:FREMD' } });
    pruefe(name + ': alter Server, callerid vom Modell faellt weg, caller leer', r.sent && r.sent.caller === '' && !('callerid' in r.sent), r.sent || r.out.slice(0, 120));
  }
  r = await run({ ...AGENT, schema: SCHEMA_MIT_CALLER, identity: ICH, modelArgs: { subject: 'Termin', callerid: 'entra:FREMD' } });
  pruefe('Agent: alter Server, callerid vom Modell faellt weg, caller vom Aufrufer', r.sent && r.sent.caller === 'entra:95625b4e' && !('callerid' in r.sent), r.sent || r.out.slice(0, 120));

  const S_BEIDE = { type: 'object', properties: { subject: { type: 'string' }, caller: { type: 'string' }, callerid: { type: 'string' } }, required: ['subject'] };
  r = await run({ ...AGENT, schema: S_BEIDE, identity: ICH, modelArgs: { subject: 'Termin', caller: 'entra:FREMD', callerid: 'entra:FREMD' } });
  pruefe('Agent: beide angebotenen Kennungsfelder vom Aufrufer gesetzt', r.sent && r.sent.caller === 'entra:95625b4e' && r.sent.callerid === 'entra:95625b4e', r.sent || r.out.slice(0, 120));
  r = await run({ ...SUB, schema: S_BEIDE, identity: ICH, modelArgs: { subject: 'Termin', caller: 'entra:FREMD', callerid: 'entra:FREMD' } });
  pruefe('Sub-Agent: beide angebotenen Kennungsfelder leer', r.sent && r.sent.caller === '' && r.sent.callerid === '', r.sent || r.out.slice(0, 120));

  for (const [WO, name] of [[AGENT, 'Agent'], [SUB, 'Sub-Agent'], [BG, 'Background Checker']]) {
    r = await run({ ...WO, schema: null, identity: ICH, modelArgs: { subject: 'Termin', callerid: 'entra:FREMD', caller: 'entra:FREMD', caller_id: 'x', user: 'web:hannah' } });
    pruefe(name + ': ohne lesbares Schema gehen keine Kennungsnamen hinaus', r.sent && r.sent.subject === 'Termin'
      && !('callerid' in r.sent) && !('caller' in r.sent) && !('caller_id' in r.sent) && !('user' in r.sent), r.sent || r.out.slice(0, 120));
  }

  // Klammer-Reparatur im Sub-Agenten: die absichtlich leere Kennung ist kein
  // fehlendes Pflichtfeld, der reparierte Aufruf geht durch.
  r = await run({ ...SUB, schema: S_ID_MAIL, identity: ICH, roh: '{"mcp_url":"https://mcp.example/test","tool_name":"create_event","arguments":{"message_id":"AAMk1"}' });
  pruefe('Sub-Agent: reparierter Aufruf mit leerer Kennung geht durch', r.sent && r.sent.message_id === 'AAMk1' && r.sent.callerid === '', r.sent || r.out.slice(0, 160));

  console.log(fails === 0 ? '\nAlle Pruefungen bestanden.' : `\n${fails} Pruefung(en) fehlgeschlagen.`);
  process.exit(fails === 0 ? 0 : 1);
})();
