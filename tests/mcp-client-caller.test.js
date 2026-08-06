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
        sink.push(JSON.parse(body).params.arguments);
        return { body: 'data: ' + JSON.stringify({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'OK' }] } }) };
      }
      return {};
    }
  };
}

async function run({ file, node, schema, modelArgs, identity }) {
  const sink = [];
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
  return { sent: sink[0], out: String(out) };
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

  console.log('--- Sub-Agent ---');
  r = await run({ ...SUB, schema: SCHEMA_MIT_CALLER, identity: ICH, modelArgs: { subject: 'Termin', caller: 'entra:FREMDE-PERSON' } });
  pruefe('Sub-Agent sendet leeren caller', r.sent && r.sent.caller === '', r.sent);

  console.log(fails === 0 ? '\nAlle Pruefungen bestanden.' : `\n${fails} Pruefung(en) fehlgeschlagen.`);
  process.exit(fails === 0 ? 0 : 1);
})();
