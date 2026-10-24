// Runde 11, Teilrunde 1 (B13): HTTP Tool (Agent) und die zwei Kopien HTTP Request
// Tool (Sub-Agent Runner, Background Checker) erreichen nur noch oeffentliche
// Webziele per GET. Interne Adressen, Docker-Dienste und private Netze sind
// gesperrt, Weiterleitungen werden nicht gefolgt, keine vom Modell gesetzten
// Header, jeder Aufruf steht im tool_audit_log (server_url leer, tool_name
// http_tool). Ausgefuehrt wird der ECHTE jsCode aus den Workflow-Dateien.
//   node tests/http-intern-schutz.test.js
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// {{N8N_URL}} wird auf einen DRITTEN Host gesetzt (nicht die zwei festen
// Literale), damit sich die N8N_URL-Zeile pruefen laesst.
const N8N_HOST = 'rupert-n8n.example';
function code(wf, name) {
  return wf.nodes.find(n => n.name === name).parameters.jsCode
    .replace(/\{\{SUPABASE_URL\}\}/g, 'http://db-test')
    .replace(/\{\{SUPABASE_SERVICE_KEY\}\}/g, 'svckey')
    .replace(/\{\{N8N_URL\}\}/g, 'https://' + N8N_HOST);
}

const DATEI = {
  agent: 'workflows/n8n-claw-agent.json',
  'sub-agent': 'workflows/sub-agent-runner.json',
  background: 'workflows/background-checker.json',
};
const KNOTEN = { agent: 'HTTP Tool', 'sub-agent': 'HTTP Request Tool', background: 'HTTP Request Tool' };
const WF = {};
for (const k of Object.keys(DATEI)) WF[k] = JSON.parse(fs.readFileSync(path.join(REPO, DATEI[k]), 'utf8'));

let n = 0, f = 0;
function pruefe(name, ok, info) { n++; if (!ok) f++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  -> ' + JSON.stringify(info).slice(0, 320))); }

// Fuehrt den echten Knotencode aus. getAntwort ist, was der eigentliche GET
// liefert (String, volle Antwort {statusCode,headers,body} oder ein Error).
// URL wird im Aufruf VERDECKT (undefined), damit ein versehentliches new URL()
// auffaellt (die Sandbox hat URL nicht verlaesslich, siehe
// reference_n8n_code_node_sandbox); der Code nutzt zerlegen().
async function lauf(herkunft, eingabe, getAntwort) {
  const gets = [], audits = [];
  const helpers = {
    async httpRequest(o) {
      if (o.method === 'POST' && String(o.url).includes('tool_audit_log')) { audits.push(o); return {}; }
      gets.push(o);
      if (getAntwort instanceof Error) throw getAntwort;
      return getAntwort;
    },
  };
  const $ = () => ({ first: () => ({ json: { sessionId: 'web:freddy', qualifiedUserId: 'web:freddy', source: 'web' } }) });
  const name = KNOTEN[herkunft];
  const query = herkunft === 'agent' ? JSON.stringify(eingabe) : eingabe;
  const fn = new AsyncFunction('query', 'helpers', '$', '$execution', 'URL', code(WF[herkunft], name));
  const out = await fn(query, helpers, $, { id: 'exec-test' }, undefined);
  return { out: String(out), gets, audits };
}

function auditZeile(r) { try { return JSON.parse(r.audits[0].body); } catch (e) { return null; } }

const HERKUENFTE = ['agent', 'sub-agent', 'background'];
const REJECT = /Interne Adressen, Docker-Dienste und private Netze sind gesperrt/;
const NICHT_GET = /macht nur GET-Abrufe und sendet keine eigenen Header/;
const WEITER = /leitet weiter/;

// Interne Ziele und rohe IP-Literale, die alle drei Knoten abweisen muessen (aus
// den Faellen 202664, 203500, den geforderten Netzen/Schreibweisen und den
// Befunden zu IPv4-mapped-IPv6 in Langschreibweise und mehrfachem trailing dot).
const INTERN = [
  'https://file-bridge:3200/health',          // 202664
  'http://file-bridge:3200/files/dummy',       // 203500
  'http://kong:8000/rest/v1/soul',
  'http://rest:3000/template_credentials',
  'http://127.0.0.1/',
  'http://10.1.2.3/x',
  'http://169.254.169.254/latest/meta-data',
  'http://[::1]/',
  'http://0x7f000001/',
  'http://2130706433/',
  'http://localhost/',
  'https://agent.sltg.at/webhook/agent',           // fester eigener Host
  'https://slt.friedemann-schuetz.de/x',           // fester eigener Host
  'https://' + N8N_HOST + '/mcp/wetter',           // Host aus {{N8N_URL}}
  'http://[0:0:0:0:0:ffff:127.0.0.1]/',            // IPv4-mapped IPv6, Langform -> Loopback
  'http://[0:0:0:0:0:ffff:10.0.0.5]/',             // mapped -> privat 10/8
  'http://[0:0:0:0:0:ffff:172.18.0.2]/',           // mapped -> Docker-Bridge 172.18.0.x
  'http://[0:0:0:0:0:ffff:169.254.169.254]/',      // mapped -> feste Metadaten-IP
  'http://[2606:4700:4700::1111]/',                // rohe IPv6 grundsaetzlich gesperrt (nur Namen erlaubt)
  'http://kong../',                                // mehrfacher trailing dot (eine Zahl reicht nicht)
];
const EXTERN = ['https://api.open-meteo.com/v1/forecast', 'https://archive.org/wayback', 'https://salzburgerland.com/de/'];

(async () => {
  for (const h of HERKUENFTE) {
    console.log('--- ' + h + ' (' + KNOTEN[h] + ') ---');

    // Interne Ziele: abgewiesen, KEIN GET ans Ziel, eine rejected-Protokollzeile
    for (const u of INTERN) {
      const r = await lauf(h, { url: u }, 'DARF-NICHT-ABGERUFEN-WERDEN');
      const z = auditZeile(r);
      pruefe(h + ' sperrt ' + u, REJECT.test(r.out) && r.gets.length === 0
        && r.audits.length === 1 && z && z.status === 'rejected'
        && z.server_url === null && z.tool_name === 'http_tool' && z.write_source === 'builtin' && z.is_write === false,
        { out: r.out.slice(0, 80), gets: r.gets.length, z });
    }

    // Externe Ziele: GET laeuft, Antwort kommt zurueck, Protokoll ok
    for (const u of EXTERN) {
      const r = await lauf(h, { url: u }, 'INHALT-' + u);
      const z = auditZeile(r);
      pruefe(h + ' laesst ' + u + ' durch (GET)', r.out === ('INHALT-' + u) && r.gets.length === 1
        && r.gets[0].method === 'GET' && r.gets[0].timeout === 30000
        && r.gets[0].disableFollowRedirect === true && !('headers' in r.gets[0])
        && z && z.status === 'ok' && z.server_url === null && z.tool_name === 'http_tool',
        { out: r.out.slice(0, 60), gets: r.gets[0], z });
    }

    // Nur GET: POST (und PUT) werden abgewiesen, ohne Netzaufruf
    for (const m of ['POST', 'PUT', 'DELETE']) {
      const r = await lauf(h, { url: 'https://api.open-meteo.com/v1/forecast', method: m }, 'NICHT');
      const z = auditZeile(r);
      pruefe(h + ' weist ' + m + ' ab (nur GET)', NICHT_GET.test(r.out) && r.gets.length === 0
        && z && z.status === 'rejected', { out: r.out.slice(0, 80), gets: r.gets.length });
    }

    // Weiterleitung auf ein internes Ziel wird NICHT gefolgt, sondern als 3xx
    // mit Zieladresse zurueckgegeben (Gegenmassnahme zum Umleiter-Fall L1).
    const red = await lauf(h, { url: 'https://umleiter.example/go' },
      { statusCode: 302, headers: { location: 'http://kong:8000/rest/v1/soul' }, body: '' });
    pruefe(h + ' folgt einer Weiterleitung auf kong NICHT', WEITER.test(red.out)
      && red.out.includes('http://kong:8000/rest/v1/soul') && red.gets.length === 1
      && !red.gets.some(g => String(g.url).includes('kong:8000')),
      { out: red.out.slice(0, 120), gets: red.gets.map(g => g.url) });

    // 4xx/5xx des Ziels: der Abruf laeuft (ein GET), aber die Fehlerseite kommt
    // mit Statushinweis zurueck, nicht als gueltiger Inhalt. So haelt das Modell
    // eine 404-/429-Seite nicht faelschlich fuer Inhalt.
    const fehlseite = await lauf(h, { url: 'https://api.open-meteo.com/v1/forecast' },
      { statusCode: 503, headers: {}, body: '<html>503 Service Unavailable</html>' });
    const zf = auditZeile(fehlseite);
    pruefe(h + ' meldet 5xx als Fehlerstatus, nicht als Inhalt', /Status 503/.test(fehlseite.out)
      && !/^<html>/.test(fehlseite.out) && fehlseite.gets.length === 1
      && zf && zf.status === 'ok' && /503 Fehlerstatus/.test(zf.result_summary || ''),
      { out: fehlseite.out.slice(0, 80), z: zf });

    // Keine vom Modell gesetzten Header: ein mitgeschickter Authorization-Header
    // landet nicht im GET.
    const mitHeader = await lauf(h, { url: 'https://api.open-meteo.com/v1/forecast', headers: { Authorization: 'Bearer geheim', Cookie: 'x=1' } }, 'OK');
    pruefe(h + ' sendet keine Modell-Header', mitHeader.gets.length === 1 && !('headers' in mitHeader.gets[0]),
      mitHeader.gets[0]);
  }

  // Agent traegt Sitzung/Nutzer aus Merge Input ins Protokoll; die Kopien nicht.
  const ra = await lauf('agent', { url: 'https://file-bridge:3200/health' }, 'X');
  const za = auditZeile(ra);
  pruefe('agent: Protokoll traegt Sitzung und Nutzer', za && za.session_id === 'web:freddy' && za.user_id === 'web:freddy' && za.origin === 'agent', za);
  const rs = await lauf('sub-agent', { url: 'https://file-bridge:3200/health' }, 'X');
  const zs = auditZeile(rs);
  pruefe('sub-agent: Protokoll ohne Sitzung (origin sub-agent)', zs && zs.session_id === null && zs.user_id === null && zs.origin === 'sub-agent', zs);
  const rb = await lauf('background', { url: 'https://file-bridge:3200/health' }, 'X');
  const zb = auditZeile(rb);
  pruefe('background: Protokoll ohne Sitzung (origin background)', zb && zb.session_id === null && zb.origin === 'background', zb);

  // Netzfehler des GET: ehrliche Fehlermeldung, Protokoll error, kein Absturz
  const nf = await lauf('agent', { url: 'https://api.open-meteo.com/v1/forecast' }, new Error('ECONNREFUSED'));
  const znf = auditZeile(nf);
  pruefe('agent: Netzfehler wird abgefangen (Protokoll error)', /Abruf fehlgeschlagen/.test(nf.out) && znf && znf.status === 'error', nf.out.slice(0, 80));

  // Die Sperrfunktion (ab "const REST =") ist in allen drei Knoten byteweise gleich.
  function common(h) {
    const js = WF[h].nodes.find(x => x.name === KNOTEN[h]).parameters.jsCode;
    const i = js.indexOf('const REST =');
    return i >= 0 ? js.slice(i) : null;
  }
  const ca = common('agent'), cs = common('sub-agent'), cb = common('background');
  pruefe('Sperrfunktion byteweise gleich in allen drei HTTP-Knoten', ca && ca === cs && ca === cb,
    { agent: (ca || '').length, sub: (cs || '').length, bg: (cb || '').length });
  // Kein new URL() im ausfuehrbaren Code (nur im erklaerenden Kommentar erlaubt);
  // die 71 Faelle oben liefen mit verdecktem URL und beweisen das zusaetzlich.
  const ohneKommentar = (ca || '').split('\n').filter(z => !z.trim().startsWith('//')).join('\n');
  pruefe('Sperrfunktion enthaelt zerlegen() und erlaubt() ohne new URL() im Code',
    ca && ca.includes('function zerlegen(') && ca.includes('function erlaubt(') && !ohneKommentar.includes('new URL('),
    { zerlegen: ca && ca.includes('function zerlegen('), neuUrlImCode: ohneKommentar.includes('new URL(') });

  console.log('\n' + (n - f) + ' von ' + n + ' Faellen bestanden');
  process.exit(f ? 1 : 0);
})();
