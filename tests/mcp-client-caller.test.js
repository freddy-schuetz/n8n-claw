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

async function run({ file, node, schema, modelArgs, identity }) {
  const sink = [];
  sink.sent = undefined; sink.audit = undefined;
  const $ = (name) => ({
    first: () => {
      if (identity === undefined) throw new Error('kein Merge Input');
      return { json: identity };
    }
  });
  const fn = new AsyncFunction('query', 'helpers', '$', '$execution',
    loadCode(file, node) + '\n//# sourceURL=mcp-client.js');
  const out = await fn(
    { mcp_url: 'https://mcp.example/test', tool_name: 'create_event', arguments: modelArgs },
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

  console.log('--- Sub-Agent ---');
  r = await run({ ...SUB, schema: SCHEMA_MIT_CALLER, identity: ICH, modelArgs: { subject: 'Termin', caller: 'entra:FREMDE-PERSON' } });
  pruefe('Sub-Agent sendet leeren caller', r.sent && r.sent.caller === '', r.sent);

  r = await run({ ...SUB, schema: SCHEMA_MAIL, identity: ICH, modelArgs: { id: 'AAMk123' } });
  pruefe('Sub-Agent: id wird zu message_id', r.sent && r.sent.message_id === 'AAMk123', r.sent);

  const BG = { file: 'workflows/background-checker.json', node: 'MCP Client' };
  r = await run({ ...BG, schema: SCHEMA_MAIL, identity: ICH, modelArgs: { id: 'AAMk123' } });
  pruefe('Background Checker: id wird zu message_id, caller leer', r.sent && r.sent.message_id === 'AAMk123' && r.sent.caller === '', r.sent);

  console.log(fails === 0 ? '\nAlle Pruefungen bestanden.' : `\n${fails} Pruefung(en) fehlgeschlagen.`);
  process.exit(fails === 0 ? 0 : 1);
})();
