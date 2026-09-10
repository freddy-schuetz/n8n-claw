// Runde 6, Nachtrag (10.09.2026): Web Reader, HTTP Tool und Browser weisen Atlassian-
// Adressen ab. Execution 132074: 175 Leser-Aufrufe, 8 Browser-Aufrufe, 11 HTTP-Aufrufe auf
// eine Confluence-Seite, alle ohne Anmeldung, zusammen ueber eine Stunde Wartezeit.
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const agent = JSON.parse(fs.readFileSync(path.join(REPO, 'workflows/n8n-claw-agent.json'), 'utf8'));
const browser = JSON.parse(fs.readFileSync(path.join(REPO, 'workflows/browser-use.json'), 'utf8'));
function code(wf, name) {
  return wf.nodes.find(n => n.name === name).parameters.jsCode.replace(/\{\{SUPABASE_URL\}\}/g, 'http://stub.local').replace(/\{\{SUPABASE_SERVICE_KEY\}\}/g, 'k').replace(/\{\{CRAWL4AI_API_TOKEN\}\}/g, 'c');
}
let n = 0, f = 0;
function pruefe(name, ok, info) { n++; if (!ok) f++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  -> ' + JSON.stringify(info).slice(0, 300))); }
async function tool(name, query) {
  const calls = [];
  const helpers = { async httpRequest(o) { calls.push(o); if (String(o.url).includes('crawl4ai')) return { results: [{ success: true, markdown: { raw_markdown: 'INHALT' } }] }; if (String(o.url).includes('stub.local')) return {}; return 'ANTWORT'; } };
  const $ = () => ({ first: () => ({ json: { sessionId: 'web:x' } }) });
  const fn = new AsyncFunction('query', 'helpers', '$', code(agent, name));
  const out = await fn(query, helpers, $);
  return { out: String(out), calls };
}
(async () => {
  console.log('--- Web Reader ---');
  let r = await tool('Web Reader', 'https://salzburger-land-tourismus.atlassian.net/wiki/spaces/TM/pages/1217626113/EmpCo');
  pruefe('Confluence-Adresse wird abgewiesen, kein Crawl', /nur ueber ihre Werkzeuge/.test(r.out) && !r.calls.some(o => String(o.url).includes('crawl4ai')), r);
  r = await tool('Web Reader', JSON.stringify({ url: 'https://id.atlassian.com/login' }));
  pruefe('Atlassian-Login ebenso', /nur ueber ihre Werkzeuge/.test(r.out), r.out);
  r = await tool('Web Reader', 'https://www.salzburgerland.com/de/');
  pruefe('andere Seiten laufen weiter', r.out === 'INHALT' && r.calls.some(o => String(o.url).includes('crawl4ai')), r);
  console.log('--- HTTP Tool ---');
  r = await tool('HTTP Tool', JSON.stringify({ url: 'https://salzburger-land-tourismus.atlassian.net/wiki/rest/api/content/1217626113' }));
  pruefe('Atlassian-API wird abgewiesen, kein Aufruf', /nur ueber ihre Werkzeuge/.test(r.out) && r.calls.length === 0, r);
  r = await tool('HTTP Tool', JSON.stringify({ url: 'https://api.open-meteo.com/v1/forecast' }));
  pruefe('andere Adressen laufen weiter, mit 30-s-Timeout', r.out === 'ANTWORT' && r.calls[0].timeout === 30000, r.calls[0]);
  console.log('--- Browser ---');
  const bc = browser.nodes.find(x => x.name === 'Route Browser Action').parameters.jsCode;
  pruefe('Browser-Schutz kennt Atlassian und die Woerter Confluence/Jira', /atlassian\\.net/.test(bc) && /confluence\|jira/.test(bc) && /Confluence und Jira gehen nicht ueber den Browser/.test(bc));
  pruefe('Beschreibungen weisen auf die Werkzeuge hin', /Not for Confluence or Jira/.test(agent.nodes.find(x => x.name === 'Web Reader').parameters.description) && /Not for Confluence, Jira or Microsoft/.test(agent.nodes.find(x => x.name === 'HTTP Tool').parameters.description));
  console.log('\n' + (n - f) + ' von ' + n + ' Faellen bestanden');
  process.exit(f ? 1 : 0);
})();
