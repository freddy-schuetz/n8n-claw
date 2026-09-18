// Begruessung hoechstens einmal am Tag (Hannah 05.09.2026, Lea 15.09.2026).
// Die Prompt-Regel hat nicht gegriffen: der Hinweis "Heute schon begruesst"
// stand in allen acht geprueften Laeufen von Lea im Systemprompt, das Modell
// begann trotzdem dreimal mit "Griass di Lea". Seit dem 18.09.2026 kappt der
// Knoten "Abbruch-Antwort" die Grussformel mechanisch. Geprueft wird der ECHTE
// Code aus der Workflow-Datei.
//   node tests/begruessung-strip.test.js
const fs = require('node:fs');
const path = require('node:path');

const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'n8n-claw-agent.json'), 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const code = wf.nodes.find(n => n.name === 'Abbruch-Antwort').parameters.jsCode
  .replace(/\{\{SUPABASE_URL\}\}/g, 'http://stub.local')
  .replace(/\{\{SUPABASE_SERVICE_KEY\}\}/g, 'stub-key');
const abbruch = new AsyncFunction('$input', '$', code);

// Nachgebautes Umfeld: Build System Prompt meldet den Gruss-Stand, Merge Input
// die Herkunft, this.helpers schluckt den Protokoll-Schreibzugriff.
function umgebung(heuteBegruesst, quelle, anrede) {
  const $ = (name) => ({ first: () => {
    if (name === 'Build System Prompt') {
      if (heuteBegruesst === 'fehlt') return { json: {} };
      // anredeQuelle: Anzeigename, Kontoname und die Vorlieben dieser Person.
      // Nur ein Gruss an DIESE Namen wird gekappt.
      return { json: { heuteBegruesst, anredeQuelle: anrede === undefined
        ? 'lea steurer nenn mich babs oder nannerl sophie hannah rainer florian barbara' : anrede } };
    }
    if (name === 'Merge Input') return { json: { source: quelle || 'web', qualifiedUserId: 'web:lea', sessionId: 'web:lea' } };
    throw new Error('unbekannter Knoten: ' + name);
  } });
  return { $, ctx: { helpers: { httpRequest: async () => ({}) } } };
}

async function antwort(text, heuteBegruesst, quelle, anrede) {
  const u = umgebung(heuteBegruesst, quelle, anrede);
  const [r] = await abbruch.call(u.ctx, { first: () => ({ json: { output: text } }) }, u.$);
  return r.json.output;
}

let n = 0, f = 0;
function pruefe(name, ok, info) {
  n++; if (!ok) f++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  -> ' + JSON.stringify(info).slice(0, 300)));
}

(async () => {
  console.log('--- Die drei echten Faelle von Lea (15. und 16.09.2026) ---');
  const ECHT = [
    ['Griaß di Lea, gute Frage! Hier ein kurzer Überblick, was ich für dich tun kann.',
     'Lea, gute Frage! Hier ein kurzer Überblick, was ich für dich tun kann.'],
    ['Griaß di Lea, hier der Überblick zu deinem ToDo-Ordner (25 Mails gefunden).',
     'Lea, hier der Überblick zu deinem ToDo-Ordner (25 Mails gefunden).'],
    ['Servus Lea! Kurze Antwort: nur auf das Gesprochene, nicht auf den geteilten Bildschirm.',
     'Lea! Kurze Antwort: nur auf das Gesprochene, nicht auf den geteilten Bildschirm.']
  ];
  for (const [vorher, nachher] of ECHT) {
    const r = await antwort(vorher, true);
    pruefe('gekappt: ' + vorher.slice(0, 32), r === nachher, { r, erwartet: nachher });
  }

  console.log('--- Weitere Grussformeln ---');
  for (const [vorher, nachher] of [
    ['Griaß di Sophie! Nein, das kann ich so nicht sagen, ich lege Seiten überall an.',
     'Sophie! Nein, das kann ich so nicht sagen, ich lege Seiten überall an.'],
    ['Servus Rainer, der Transkriptions-Bot ist unterwegs und tritt gleich bei.',
     'Rainer, der Transkriptions-Bot ist unterwegs und tritt gleich bei.'],
    ['Hallo Hannah, die Statusseite liegt jetzt im AI Lab neben dem Feedback.',
     'Hannah, die Statusseite liegt jetzt im AI Lab neben dem Feedback.'],
    ['Grüß dich Barbara, die Tabelle ist verschoben, die Seite steht wieder.',
     'Barbara, die Tabelle ist verschoben, die Seite steht wieder.'],
    ['Guten Morgen Florian, die 14 Tickets hängen jetzt bei dir statt bei Martina.',
     'Florian, die 14 Tickets hängen jetzt bei dir statt bei Martina.'],
  ]) {
    const r = await antwort(vorher, true);
    pruefe('gekappt: ' + vorher.slice(0, 26), r === nachher, { r, erwartet: nachher });
  }

  console.log('--- Was NICHT gekappt wird ---');
  let r = await antwort('Griaß di Lea, gute Frage! Hier ein kurzer Überblick für dich.', false);
  pruefe('erster Kontakt am Tag: Gruss bleibt', /^Griaß di Lea/.test(r), r);
  r = await antwort('Griaß di Lea, gute Frage! Hier ein kurzer Überblick für dich.', 'fehlt');
  pruefe('ohne Angabe im Prompt: Gruss bleibt (kein Raten)', /^Griaß di Lea/.test(r), r);
  r = await antwort('Servus Lea!', true);
  pruefe('reine Grussantwort bleibt stehen (sonst bliebe nichts uebrig)', r === 'Servus Lea!', r);
  r = await antwort('Hier der Überblick zu deinem ToDo-Ordner, sortiert nach Datum.', true);
  pruefe('Antwort ohne Gruss bleibt unveraendert', r === 'Hier der Überblick zu deinem ToDo-Ordner, sortiert nach Datum.', r);
  r = await antwort('Hiermit ist der Termin abgesagt, die Absage ging an alle Teilnehmenden.', true);
  pruefe('"Hiermit" wird nicht als "Hi" gelesen', /^Hiermit/.test(r), r);
  r = await antwort('Servus-Grüße sind in dieser Abteilung üblich, schreibt Barbara in der Seite.', true);
  pruefe('"Servus-Grüße" als Wortbestandteil bleibt', /^Servus-Grüße/.test(r), r);
  r = await antwort('Moin heißt in Hamburg den ganzen Tag hallo, das steht so im Protokoll.', true);
  pruefe('Grussformel als Satzsubjekt bleibt stehen', /^Moin heißt/.test(r), r);
  r = await antwort('Hallo, der Termin ist angelegt und die Einladung ist unterwegs.', true);
  pruefe('Gruss ohne Namen bleibt stehen (er koennte jemand anderem gelten)', /^Hallo, der Termin/.test(r), r);
  r = await antwort('Griaß di ist die Salzburger Grußformel, die ich von deiner Kollegin übernommen habe.', true);
  pruefe('"Griaß di" als Gegenstand des Satzes bleibt', /^Griaß di ist/.test(r), r);

  console.log('--- Was Rupert nur WIEDERGIBT, bleibt unangetastet (Review 18.09.2026) ---');
  // Der erste Entwurf schnitt jede fuehrende Grussformel weg und zerstoerte damit
  // Mailentwuerfe und weitergegebene Nachrichten. Der verstuemmelte Text landet
  // ueber "Save Conversation and Log" auch dauerhaft im Verlauf.
  for (const [name, text, muster] of [
    ['Mailentwurf an eine fremde Person',
     'Hallo Frau Huber,\n\nvielen Dank für Ihre Anfrage. Den Termin am Donnerstag kann ich bestätigen.\n\nMit freundlichen Grüßen\nLea',
     /^Hallo Frau Huber,/],
    ['Mailentwurf mit Betreffzeile',
     'Betreff: Medienreise\n\nGuten Tag Herr Mayer,\n\nanbei die Unterlagen zur Medienreise.',
     /^Betreff: Medienreise/],
    ['weitergegebene Kanalnachricht',
     'Hallo zusammen, kurze Erinnerung an das Redaktionsmeeting am Montag um 9 Uhr.',
     /^Hallo zusammen,/],
    ['Protokollzeile',
     'Servus miteinander, wir starten mit dem Rückblick auf die letzte Woche und die offenen Punkte.',
     /^Servus miteinander,/],
    ['Entwurf an eine Namensvetterin, erkannt an der Schlussformel',
     'Hallo Lea,\n\nanbei wie besprochen die Liste der Partnerbetriebe.\n\nLiebe Grüße',
     /^Hallo Lea,/]
  ]) {
    r = await antwort(text, true);
    pruefe(name + ' bleibt unveraendert', muster.test(r), r.slice(0, 80));
  }
  r = await antwort('Griaß di Lea, hier der Entwurf:\n\nHallo Frau Huber,\n\nvielen Dank für Ihre Anfrage.', true);
  // Hier ist der aeussere Gruss wirklich Ruperts eigener: er darf weg, der Entwurf
  // darunter muss vollstaendig bleiben.
  pruefe('eigener Gruss vor einem Entwurf: Gruss weg, Entwurf unversehrt',
    /^Lea, hier der Entwurf:/.test(r) && r.includes('Hallo Frau Huber,'), r.slice(0, 80));
  r = await antwort('Griaß di Lea, hier der Überblick zu deinen Terminen heute und morgen.', true, 'web', '');
  pruefe('ohne bekannte Namen wird nicht gekappt', /^Griaß di Lea/.test(r), r);

  console.log('--- Vereinbarte Anreden bleiben (Babs, Nannerl) ---');
  r = await antwort('Griaß di Babs, die zwei Zeilen stehen jetzt in der Aufgabentabelle.', true);
  pruefe('Anrede Babs bleibt erhalten', r === 'Babs, die zwei Zeilen stehen jetzt in der Aufgabentabelle.', r);
  r = await antwort('Stimmt, Babs – ein AI-Lab-Chat hat einen eigenen Gesprächsverlauf.', true);
  pruefe('Anrede mitten im Satz unberuehrt', /^Stimmt, Babs/.test(r), r);

  console.log('--- Geplante Laeufe werden nicht beschnitten ---');
  // Erinnerung, Heartbeat und geplante Aufgabe: dort gibt es keinen "zweiten
  // Kontakt am Tag", auf den sich die Regel bezieht.
  for (const q of ['scheduled_task', 'scheduled_action', 'heartbeat', 'background']) {
    r = await antwort('Griaß di Lea, hier deine Erinnerung an die Hermann-Bestellung von morgen.', true, q);
    pruefe(q + ': Gruss bleibt', /^Griaß di Lea/.test(r), r.slice(0, 60));
  }
  r = await antwort('Griaß di Lea, hier deine Termine für heute und morgen im Überblick.', true, 'telegram');
  pruefe('telegram: Gruss wird gekappt wie im Webchat', /^Lea, hier deine Termine/.test(r), r.slice(0, 60));

  console.log('--- Regression: die Ersatztexte ---');
  r = await antwort('', true);
  pruefe('leere Antwort: Ersatztext, nicht gekappt', /technischer Fehler/.test(r), r);
  const u = umgebung(true, 'scheduled_task');
  const [g] = await abbruch.call(u.ctx, { first: () => ({ json: { output: '' } }) }, u.$);
  pruefe('geplante Aufgabe: eigener Ersatztext', /geplante Aufgabe/.test(g.json.output), g.json.output);
  const u2 = umgebung(true, 'web');
  const [l] = await abbruch.call(u2.ctx, { first: () => ({ json: { output: 'Agent stopped due to max iterations.' } }) }, u2.$);
  pruefe('Iterationslimit: eigener Ersatztext', /zu viele Zwischenschritte/.test(l.json.output), l.json.output);

  console.log('\n' + (n - f) + ' von ' + n + ' Faellen bestanden');
  process.exit(f ? 1 : 0);
})();
