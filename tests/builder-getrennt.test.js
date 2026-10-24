// Runde 11a (23.10.2026): die Builder-Werkzeuge sind vom Agenten getrennt.
// Self Modify, WorkflowBuilder, MCP Builder, Library Manager und Agent Library
// gibt es im Agenten nicht mehr; Anbindungen, Skills, Experten und Team-Befehle
// richtet Freddy von Hand ein. Self Modify gab ohne Rechtepruefung das
// Workflow-JSON samt eingesetzter Schluessel heraus.
// Der Test faengt eine Wiedereinfuehrung ab, etwa beim Mergen von main (dort
// haengen die fuenf noch am Agenten), und prueft die Seed-Texte ALLER
// claw_agents-Eintraege in setup.sh und supabase/migrations/002_seed.sql
// (ausser persona:*): setup.sh schreibt sie bei jedem Lauf, onboarding und
// fitness_routing boten das Bauen noch an, als nur fuenf Eintraege geprueft wurden.
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const AGENT = 'workflows/n8n-claw-agent.json';
const ENTFERNT = ['Self Modify', 'WorkflowBuilder', 'MCP Builder', 'Library Manager', 'Agent Library'];
const IDS = ['tool-self-modify', 'tool-workflow-builder', 'mcp-builder-tool', 'tool-library-manager', 'tool-agent-library'];
// Die Werkzeugmenge wird festgehalten, nicht die Zahl der Knoten.
const WERKZEUGE = ['Browser Action', 'Entity Manager', 'Expert Agent', 'HTTP Tool', 'MCP Client', 'Memory Delete', 'Memory Save',
  'Memory Search', 'Memory Update', 'Project Manager', 'Reminder', 'Task Manager', 'Web Reader', 'Web Search'];
// Was nur in den fuenf Knoten stand (n8n-Schluessel, interne API, Platzhalter der Sub-Workflows)
const NUR_IN_DEN_FUENF = ['REPLACE_WORKFLOW_BUILDER_ID', 'REPLACE_MCP_BUILDER_ID', 'REPLACE_LIBRARY_MANAGER_ID',
  'REPLACE_AGENT_LIBRARY_MANAGER_ID', '{{N8N_API_KEY}}', '{{N8N_INTERNAL_URL}}', '/api/v1/workflows', 'X-N8N-API-KEY'];
const VERBOTEN = /(self.?modify|mcp.?builder|workflow.?builder|agent.?library|library.?manager|build new api integrations|api connection)/i;
const STRICH_RE = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');   // Halbgeviert- und Geviertstrich

let n = 0, f = 0;
function pruefe(name, ok, info) {
  n++;
  if (!ok) f++;
  console.log((ok ? '  OK   ' : '  FEHL ') + name + (ok ? '' : '   -> ' + JSON.stringify(info).slice(0, 400)));
}
function lies(datei) { return fs.readFileSync(path.join(REPO, datei), 'utf8').replace(/\r\n/g, '\n'); }

// Inhalt des SQL-Literals hinter ('<key>', '...'): '' steht fuer ein Apostroph,
// das erste einzelne Apostroph beendet das Literal.
function literal(text, key) {
  const kopf = "('" + key + "', '";
  const a = text.indexOf(kopf);
  if (a < 0 || text.indexOf(kopf, a + 1) >= 0) return null;
  let i = a + kopf.length, aus = '';
  while (i < text.length) {
    if (text[i] === "'") {
      if (text[i + 1] === "'") { aus += "'"; i += 2; continue; }
      return aus;
    }
    aus += text[i++];
  }
  return null;
}
// Alle Eintraege der INSERTs in claw_agents: je ('key', '...') bis ON CONFLICT.
// Nach jedem Literal wird erst hinter seinem Ende weitergesucht, ein "('" im Text
// stoert also nicht. null, wenn der Aufbau nicht passt.
function clawAgentsEintraege(text) {
  const aus = [];
  const kopf = /INSERT INTO public\.claw_agents \(key, content\) VALUES/g;
  let m;
  while ((m = kopf.exec(text)) !== null) {
    let i = m.index + m[0].length;
    const ende = text.indexOf('ON CONFLICT', i);
    if (ende < 0) return null;
    for (;;) {
      const a = text.indexOf("('", i);
      if (a < 0 || a > ende) break;
      const k = text.indexOf("', '", a + 2);
      if (k < 0) return null;
      const key = text.slice(a + 2, k);
      let j = k + 4, wert = '';
      while (j < text.length && !(text[j] === "'" && text[j + 1] !== "'")) {
        if (text[j] === "'") { wert += "'"; j += 2; continue; }
        wert += text[j++];
      }
      if (j >= text.length || j > ende) return null;
      aus.push([key, wert]);
      i = j + 1;
    }
  }
  return aus;
}
function abschnitt(text) {
  const a = text.indexOf('## Neue Anbindungen\n');
  if (a < 0) return null;
  const e = text.indexOf('\n\n## ', a);
  return e < 0 ? text.slice(a) : text.slice(a, e);
}

console.log('--- Agent ohne die fuenf Werkzeuge');
const wf = JSON.parse(lies(AGENT));
const namen = wf.nodes.map(x => x.name);
pruefe('keiner der fuenf Knoten (Name oder id)', !wf.nodes.some(x => ENTFERNT.includes(x.name) || IDS.includes(x.id)),
  wf.nodes.filter(x => ENTFERNT.includes(x.name) || IDS.includes(x.id)).map(x => x.name));
const kanten = [];
for (const [q, ausg] of Object.entries(wf.connections)) {
  for (const [art, listen] of Object.entries(ausg || {})) {
    for (const liste of listen || []) for (const c of liste || []) kanten.push([q, art, c && c.node]);
  }
}
pruefe('keine Kante von oder zu einem der fuenf', !Object.keys(wf.connections).some(q => ENTFERNT.includes(q)) && !kanten.some(k => ENTFERNT.includes(k[2])),
  kanten.filter(k => ENTFERNT.includes(k[0]) || ENTFERNT.includes(k[2])));
pruefe('keine losen Kanten', Object.keys(wf.connections).every(q => namen.includes(q)) && kanten.every(k => namen.includes(k[2])),
  kanten.filter(k => !namen.includes(k[0]) || !namen.includes(k[2])));
const roh = lies(AGENT);
pruefe('nichts mehr, was nur in den fuenf stand (Schluessel, interne API, Platzhalter)', NUR_IN_DEN_FUENF.every(s => !roh.includes(s)),
  NUR_IN_DEN_FUENF.filter(s => roh.includes(s)));
const werkzeuge = kanten.filter(k => k[1] === 'ai_tool' && k[2] === 'AI Agent').map(k => k[0]).sort();
pruefe('genau die 14 Werkzeuge haengen per ai_tool am AI Agent', JSON.stringify(werkzeuge) === JSON.stringify([...WERKZEUGE].sort()), werkzeuge);
pruefe('jedes der 14 Werkzeuge ist ein Knoten', WERKZEUGE.every(w => namen.includes(w)), WERKZEUGE.filter(w => !namen.includes(w)));
const sonstige = wf.nodes.filter(x => ENTFERNT.some(e => JSON.stringify(x.parameters || {}).includes(e))).map(x => x.name);
pruefe('kein anderer Knoten nennt einen der fuenf Namen', sonstige.length === 0, sonstige);

console.log('--- Seeds der Prompt-Eintraege');
const sh = lies('setup.sh');
const seed = lies('supabase/migrations/002_seed.sql');
const texte = {
  'setup.sh tools': literal(sh, 'tools'),
  'setup.sh mcp_instructions': literal(sh, 'mcp_instructions'),
  'setup.sh expert_agents': literal(sh, 'expert_agents'),
  '002_seed.sql mcp_instructions': literal(seed, 'mcp_instructions'),
  '002_seed.sql expert_agents': literal(seed, 'expert_agents'),
};
for (const [wo, t] of Object.entries(texte)) {
  pruefe(wo + ': gefunden und ohne Builder-Hinweis', t !== null && !VERBOTEN.test(t), t === null ? 'nicht gefunden' : (t.match(VERBOTEN) || [])[0]);
}
const satz = 'New experts are added by Freddy (the operator). You cannot install, remove or change experts yourself; ' +
  'if someone wants a new expert, offer to note it with "Feedback eintragen: ...".';
for (const wo of ['setup.sh expert_agents', '002_seed.sql expert_agents']) {
  const t = texte[wo] || '';
  pruefe(wo + ': endet mit dem Satz zu Freddy, getrennt durch eine Leerzeile', t.endsWith('interpretation.\n\n' + satz), t.slice(-160));
}
const a1 = abschnitt(texte['setup.sh mcp_instructions'] || '');
const a2 = abschnitt(texte['002_seed.sql mcp_instructions'] || '');
pruefe('mcp_instructions: Abschnitt "Neue Anbindungen" in beiden Seeds, gleicher Wortlaut, verweist auf Freddy und Feedback eintragen',
  a1 !== null && a1 === a2 && /Freddy/.test(a1) && /Feedback eintragen/.test(a1), [a1, a2]);
pruefe('mcp_instructions: Abschnitt ohne Gedankenstriche', a1 !== null && !STRICH_RE.test(a1), a1);
pruefe('tools: kein Block WORKFLOW BUILDER mehr, REMINDER direkt vor MEMORY',
  !/WORKFLOW BUILDER/.test(texte['setup.sh tools'] || '') && /time \+ message\n\nMEMORY \(memory_search/.test(texte['setup.sh tools'] || ''),
  (texte['setup.sh tools'] || '').slice(0, 400));

console.log('--- Alle claw_agents-Eintraege der Seeds (ausser persona:*)');
const alle = { 'setup.sh': clawAgentsEintraege(sh), '002_seed.sql': clawAgentsEintraege(seed) };
const PFLICHT = { 'setup.sh': ['tools', 'mcp_instructions', 'expert_agents', 'onboarding', 'fitness_routing', 'telegram_status'],
  '002_seed.sql': ['mcp_instructions', 'expert_agents', 'knowledge_graph'] };
for (const [wo, liste] of Object.entries(alle)) {
  const keys = (liste || []).map(e => e[0]);
  pruefe(wo + ': Eintraege lesbar, darunter ' + PFLICHT[wo].join(', '), liste !== null && PFLICHT[wo].every(k => keys.includes(k)), keys);
  const treffer = (liste || []).filter(([k, t]) => !k.startsWith('persona:') && VERBOTEN.test(t))
    .map(([k, t]) => k + ': ' + t.match(VERBOTEN)[0]);
  pruefe(wo + ': kein Eintrag nennt ein Builder-Werkzeug oder bietet das Bauen an (' + keys.filter(k => !k.startsWith('persona:')).length + ' Eintraege)',
    liste !== null && treffer.length === 0, treffer);
}
const eintrag = (wo, key) => ((alle[wo] || []).find(e => e[0] === key) || [null, ''])[1];
pruefe('setup.sh onboarding: Faehigkeitsliste ohne Bau-Angebot, sonst erhalten',
  /Remember things \("Remember: I take my coffee black"\)\n- Respond/.test(eintrag('setup.sh', 'onboarding')),
  eintrag('setup.sh', 'onboarding').slice(-500));
pruefe('setup.sh fitness_routing: verweist auf Freddy statt auf library_manager',
  eintrag('setup.sh', 'fitness_routing').endsWith('the call will fail; only then say that Freddy (the operator) installs new skills.'),
  eintrag('setup.sh', 'fitness_routing').slice(-160));

console.log(f === 0 ? '\nAlle ' + n + ' Pruefungen bestanden.' : '\n' + f + ' von ' + n + ' Pruefung(en) fehlgeschlagen.');
process.exit(f === 0 ? 0 : 1);
