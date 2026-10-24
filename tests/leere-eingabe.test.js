// Prueft den Schutz gegen leere Eingabe in den Code-Werkzeugen (Runde 9,
// 19.10.2026). Ruft das Modell ein Code-Werkzeug ohne Eingabe auf, ist "query"
// im Task Runner gar nicht deklariert (undefined faellt beim Transport weg), und
// jeder direkte Zugriff wirft. Web Search ist so am 13.10.2026 abgestuerzt.
// Ausgefuehrt wird der ECHTE Code aus der Workflow-Datei, einmal ohne query
// (wie im Task Runner), einmal mit leerem Text. Netzwerk gibt es nicht: der
// Schutz muss vorher antworten.
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Genau die Werkzeuge, die am alten Code bei leerer Eingabe abstuerzten
// (gemessen 19.10.2026). Die anderen antworten schon mit einer genaueren
// Meldung oder zeigen die Liste und bleiben unberuehrt (UNBERUEHRT unten).
const ZIELE = {
  'workflows/n8n-claw-agent.json': ['Memory Search', 'Memory Save', 'HTTP Tool', 'Web Search', 'Web Reader'],
  'workflows/sub-agent-runner.json': ['Web Search', 'Web Reader'],
  'workflows/background-checker.json': ['Web Search', 'Web Reader'],
};
const UNBERUEHRT = {
  'workflows/n8n-claw-agent.json': ['Memory Delete', 'Memory Update', 'Entity Manager', 'Task Manager', 'Project Manager', 'MCP Client'],
  'workflows/sub-agent-runner.json': ['HTTP Request Tool', 'MCP Client'],
  'workflows/background-checker.json': ['HTTP Request Tool', 'MCP Client'],
};
const MARKE = '// Leere Eingabe abfangen (19.10.2026)';

const keinNetz = { httpRequest: async () => { throw new Error('Netzwerk im Test: der Schutz haette vorher antworten muessen'); } };
const kein$ = () => { throw new Error('$() im Test: der Schutz haette vorher antworten muessen'); };

let fails = 0;
function pruefe(name, bedingung, detail) {
  if (!bedingung) fails++;
  console.log((bedingung ? '  OK   ' : '  FEHL ') + name + (bedingung ? '' : '   -> ' + JSON.stringify(detail)));
}

(async () => {
  for (const [datei, namen] of Object.entries(ZIELE)) {
    const wf = JSON.parse(fs.readFileSync(path.join(REPO, datei), 'utf8'));
    for (const name of namen) {
      const node = wf.nodes.find(n => n.name === name);
      if (!node) { pruefe(datei + ' / ' + name + ' vorhanden', false, 'fehlt'); continue; }
      const code = node.parameters.jsCode;
      // ohne Parameter "query": genau so sieht der Task Runner bei leerem Aufruf aus
      let aus;
      try { aus = await new AsyncFunction('helpers', '$', '$execution', code)(keinNetz, kein$, { id: 't' }); }
      catch (e) { aus = 'WARF: ' + e.message; }
      pruefe(path.basename(datei) + ' / ' + name + ': ohne query klare Antwort',
        typeof aus === 'string' && aus.startsWith('Aufruf ohne Eingabe'), String(aus).slice(0, 120));
      for (const leer of ['', '   ', null]) {
        try { aus = await new AsyncFunction('query', 'helpers', '$', '$execution', code)(leer, keinNetz, kein$, { id: 't' }); }
        catch (e) { aus = 'WARF: ' + e.message; }
        pruefe(path.basename(datei) + ' / ' + name + ': query=' + JSON.stringify(leer) + ' klare Antwort',
          typeof aus === 'string' && aus.startsWith('Aufruf ohne Eingabe'), String(aus).slice(0, 120));
      }
      // Gegenprobe: eine echte Eingabe muss am Schutz vorbeikommen. Ein Wurf aus
      // der Netz- oder $-Attrappe heisst: der Code lief weiter, also gut.
      for (const echt of ['x', '{"q":"Wellpass"}', '{"url":"https://example.org"}', '{"content":"Notiz"}']) {
        try { aus = await new AsyncFunction('query', 'helpers', '$', '$execution', code)(echt, keinNetz, kein$, { id: 't' }); }
        catch (e) { aus = 'WARF: ' + e.message; }
        pruefe(path.basename(datei) + ' / ' + name + ': echte Eingabe ' + echt.slice(0, 20) + ' kommt durch',
          !(typeof aus === 'string' && aus.startsWith('Aufruf ohne Eingabe')), String(aus).slice(0, 120));
      }
    }
  }
  for (const [datei, namen] of Object.entries(UNBERUEHRT)) {
    const wf = JSON.parse(fs.readFileSync(path.join(REPO, datei), 'utf8'));
    for (const name of namen) {
      const node = wf.nodes.find(n => n.name === name);
      pruefe(path.basename(datei) + ' / ' + name + ': ohne Schutz, Verhalten unveraendert',
        node && !String(node.parameters.jsCode || '').startsWith(MARKE), name);
    }
  }
  console.log(fails === 0 ? '\nAlle Pruefungen bestanden.' : '\n' + fails + ' Pruefung(en) fehlgeschlagen.');
  process.exit(fails === 0 ? 0 : 1);
})();
