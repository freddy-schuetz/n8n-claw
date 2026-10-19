// Runde 10 (19.10.2026): naechtliche Zusammenfassung (Memory Consolidation).
// Am 09.10. und 17.10.2026 fehlte je ein Tag: Sonnet 5 dachte ungefragt, vorn
// stand ein thinking-Block, content[0].text war undefined, das Speichern
// scheiterte mit 400 und der Zeiger lief trotzdem weiter. Ausserdem legte die
// Zusammenfassung Personen zusammen, weil das Protokoll keine Namen trug.
// Der ECHTE Code des Knotens "Consolidate Memory" laeuft gegen eine
// nachgebaute Datenschnittstelle und ein nachgebautes Modell.
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const wf = JSON.parse(fs.readFileSync(path.join(REPO, 'workflows/memory-consolidation.json'), 'utf8'));
const CODE = wf.nodes.find(n => n.name === 'Consolidate Memory').parameters.jsCode
  .replace(/\{\{SUPABASE_URL\}\}/g, 'http://stub.local')
  .replace(/\{\{SUPABASE_SERVICE_KEY\}\}/g, 'stub-key');

const HEUTE = new Date().toISOString().slice(0, 10);
const PROFILE = [
  { user_id: 'web:barbara', display_name: 'Barbara Walzer' },
  { user_id: 'entra:ea13', display_name: '(FH) Waltraud Paradeiser' },
  { user_id: 'entra:4149', display_name: 'Alina Leitner,' },
  { user_id: 'telegram:1810565648', display_name: 'Freddy' },
  { user_id: 'web:hannah', display_name: 'Hannah Traussnigg' }
];

function zeile(id, date, user_id, content) { return { id, date, user_id, role: 'interaction', content, created_at: date + 'T08:00:00Z' }; }
const LANG = ' Inhalt mit genug Text, damit der Tag nicht als zu kurz gilt und zusammengefasst wird.';

async function run(opts) {
  const st = {
    cfg: Object.assign({ insights: false }, opts.cfg || { last_id: 0 }),
    vorhanden: Object.assign({}, opts.vorhanden || {}),
    gespeichert: [], llm: [], cursorSchreiben: 0
  };
  const tageMitFehler = opts.speichernFehler || [];
  const helpers = {
    async httpRequest(o) {
      const url = String(o.url || '');
      const voll = (body, statusCode = 200) => (o.returnFullResponse ? { statusCode, body } : body);
      if (url.startsWith('https://api.anthropic.com')) {
        const b = o.body;
        st.llm.push(b);
        if (/Extract from this text/.test(b.system)) return { content: [{ type: 'text', text: '{"tags":["t"],"entities":["E"]}' }] };
        if (opts.antwort) return opts.antwort(b);
        return { content: [{ type: 'text', text: 'Zusammenfassung: ' + b.messages[0].content.slice(0, 40) }], stop_reason: 'end_turn' };
      }
      if (url.includes('/tool_audit_log')) return voll('');
      if (url.includes('/tools_config?tool_name=eq.llm_provider')) return voll([{ enabled: true, config: { provider: 'anthropic', model: opts.model || 'claude-sonnet-5', api_key: 'x' } }]);
      if (url.includes('/tools_config?tool_name=eq.embedding')) return voll([]);
      if (url.includes('/heartbeat_config?check_name=eq.memory_consolidation')) return voll([{ config: st.cfg }]);
      if (url.includes('/heartbeat_config?on_conflict=check_name')) { st.cfg = JSON.parse(JSON.stringify(o.body.config)); st.cursorSchreiben++; return voll(''); }
      if (url.includes('/memory_daily?id=gt.')) {
        const ab = Number(url.split('id=gt.')[1].split('&')[0]);
        return voll(opts.eintraege.filter(e => e.id > ab));
      }
      if (url.includes('/user_profiles?user_id=in.(')) {
        st.profilAbfrage = decodeURIComponent(url.split('in.(')[1].split(')&')[0]);
        return voll(PROFILE.filter(p => st.profilAbfrage.includes('"' + p.user_id + '"')));
      }
      if (url.includes('/memory_long?category=eq.consolidated&metadata-%3E%3Edate=eq.')) {
        const d = decodeURIComponent(url.split('date=eq.')[1].split('&')[0]);
        return voll(st.vorhanden[d] ? [{ id: 1 }] : []);
      }
      if (o.method === 'POST' && url.endsWith('/rest/v1/memory_long')) {
        if (tageMitFehler.includes(o.body.metadata.date)) return voll({ code: '23502', message: 'null value in column "content"' }, 400);
        st.gespeichert.push(o.body);
        st.vorhanden[o.body.metadata.date] = true;
        return voll('', 201);
      }
      if (o.method === 'DELETE') return voll('');
      throw new Error('unerwarteter Aufruf ' + o.method + ' ' + url);
    }
  };
  const fn = new AsyncFunction('$input', 'helpers', CODE + '\n//# sourceURL=konsolidierung.js');
  const out = await fn.call({ helpers }, { all: () => [] }, helpers);
  return { out: out[0].json, st };
}

let n = 0, f = 0;
function pruefe(name, ok, info) { n++; if (!ok) f++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  -> ' + JSON.stringify(info).slice(0, 500))); }

(async () => {
  console.log('--- Text hinter einem thinking-Block ---');
  let r = await run({
    eintraege: [zeile(1261, '2026-10-09', 'web:hannah', 'Frage von Hannah' + LANG)],
    antwort: () => ({ content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'Hannah fragte nach X.' }], stop_reason: 'end_turn' })
  });
  pruefe('Zusammenfassung aus dem text-Block gespeichert, nicht undefined', r.st.gespeichert.length === 1 && r.st.gespeichert[0].content === 'Hannah fragte nach X.', r.st.gespeichert);
  pruefe('Zeiger auf den Tag gerueckt', r.st.cfg.last_id === 1261 && r.out.new_cursor === 1261 && r.out.status === 'completed', r.out);

  console.log('--- Modell liefert keinen Text: Tag bleibt, naechste Nacht erneut ---');
  r = await run({
    cfg: { last_id: 1260, insights: false, max_days: 5 },
    eintraege: [zeile(1261, '2026-10-09', 'web:hannah', 'A' + LANG), zeile(1262, '2026-10-12', 'web:barbara', 'B' + LANG)],
    antwort: () => ({ content: [{ type: 'thinking', thinking: '', signature: 'sig' }], stop_reason: 'max_tokens' })
  });
  pruefe('nichts gespeichert, Zeiger unveraendert', r.st.gespeichert.length === 0 && r.st.cfg.last_id === 1260 && r.out.new_cursor === 1260, { cfg: r.st.cfg, out: r.out });
  pruefe('Fehlversuch 1 vermerkt, Lauf als partial, spaeterer Tag wartet', r.st.cfg.fehlversuche && r.st.cfg.fehlversuche['2026-10-09'] === 1 && r.out.status === 'partial' && r.out.failed_day === '2026-10-09' && r.out.days_deferred === 1, { cfg: r.st.cfg, out: r.out });
  pruefe('Grund nennt das fehlende Textstueck', /keinen Text/.test(JSON.stringify(r.out.processed)), r.out.processed);
  pruefe('andere Schalter der config bleiben (insights=false, max_days)', r.st.cfg.insights === false && r.st.cfg.max_days === 5, r.st.cfg);

  console.log('--- Speichern scheitert (400): Zeiger bleibt ---');
  r = await run({ cfg: { last_id: 1260 }, eintraege: [zeile(1261, '2026-10-09', 'web:hannah', 'A' + LANG)], speichernFehler: ['2026-10-09'] });
  pruefe('400 beim Speichern -> Fehlversuch, Zeiger bleibt 1260', r.st.cfg.last_id === 1260 && r.st.cfg.fehlversuche['2026-10-09'] === 1 && /HTTP 400/.test(JSON.stringify(r.out.processed)), { cfg: r.st.cfg, p: r.out.processed });

  console.log('--- Dritter Fehlversuch: Tag wird uebersprungen und vermerkt ---');
  r = await run({
    cfg: { last_id: 1260, fehlversuche: { '2026-10-09': 2 } },
    eintraege: [zeile(1261, '2026-10-09', 'web:hannah', 'A' + LANG), zeile(1262, '2026-10-12', 'web:barbara', 'B' + LANG)],
    speichernFehler: ['2026-10-09']
  });
  pruefe('Tag uebersprungen, in uebersprungen vermerkt, Zaehler weg', Array.isArray(r.st.cfg.uebersprungen) && r.st.cfg.uebersprungen[0].date === '2026-10-09' && !r.st.cfg.fehlversuche['2026-10-09'], r.st.cfg);
  pruefe('naechster Tag laeuft im selben Lauf, Zeiger am Ende', r.st.gespeichert.length === 1 && r.st.gespeichert[0].metadata.date === '2026-10-12' && r.st.cfg.last_id === 1262, { g: r.st.gespeichert.map(g => g.metadata.date), cfg: r.st.cfg });

  console.log('--- Erfolg nach Fehlversuch loescht den Zaehler ---');
  r = await run({ cfg: { last_id: 1260, fehlversuche: { '2026-10-09': 1 } }, eintraege: [zeile(1261, '2026-10-09', 'web:hannah', 'A' + LANG)] });
  pruefe('Zaehler fuer den Tag entfernt', r.st.gespeichert.length === 1 && !r.st.cfg.fehlversuche['2026-10-09'], r.st.cfg);

  console.log('--- Vorhandene Zusammenfassung: kein zweiter Eintrag ---');
  const sieben = ['2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17'];
  r = await run({
    cfg: { last_id: 1260 },
    eintraege: sieben.map((d, i) => zeile(1261 + i, d, 'web:barbara', d + LANG)).concat([zeile(1300, HEUTE, 'web:barbara', 'heute' + LANG)]),
    vorhanden: { '2026-10-12': true, '2026-10-13': true }
  });
  pruefe('zwei vorhandene Tage uebersprungen, fuenf neu (zaehlen nicht gegen max 5)', r.st.gespeichert.length === 5 && r.out.processed.filter(p => p.reason === 'already_consolidated').length === 2, r.out.processed);
  pruefe('kein Eintrag fuer vorhandene Tage, heute unberuehrt', !r.st.gespeichert.some(g => ['2026-10-12', '2026-10-13', HEUTE].includes(g.metadata.date)), r.st.gespeichert.map(g => g.metadata.date));
  pruefe('Zeiger hinter dem letzten Vortag, nicht auf heute', r.st.cfg.last_id === 1267 && r.out.days_deferred === 0, { cfg: r.st.cfg, out: r.out });

  console.log('--- Vorhandener Tag hinter dem fuenften: wird mit abgeraeumt ---');
  const nachhol = ['2026-10-09', '2026-10-12', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'];
  r = await run({
    cfg: { last_id: 1260 },
    eintraege: nachhol.map((d, i) => zeile(1261 + i, d, 'web:barbara', d + LANG)),
    vorhanden: { '2026-10-12': true, '2026-10-18': true }
  });
  pruefe('genau die fuenf fehlenden Tage zusammengefasst', r.st.gespeichert.map(g => g.metadata.date).join() === '2026-10-09,2026-10-14,2026-10-15,2026-10-16,2026-10-17', r.st.gespeichert.map(g => g.metadata.date));
  pruefe('Zeiger hinter dem vorhandenen 18.10., nichts wartet', r.st.cfg.last_id === 1267 && r.out.days_deferred === 0, { cfg: r.st.cfg, out: r.out });
  r = await run({
    cfg: { last_id: 1260 },
    eintraege: ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'].map((d, i) => zeile(1261 + i, d, 'web:barbara', d + LANG))
  });
  pruefe('sieben fehlende Tage: fuenf jetzt, zwei warten, Zeiger nach dem fuenften', r.st.gespeichert.length === 5 && r.out.days_deferred === 2 && r.st.cfg.last_id === 1265, { n: r.st.gespeichert.length, out: r.out, cfg: r.st.cfg });

  console.log('--- Namen im Protokoll ---');
  r = await run({
    eintraege: [
      zeile(1280, '2026-10-14', 'web:barbara', 'Babs fragt nach der Website' + LANG),
      zeile(1281, '2026-10-14', 'entra:ea13', 'Waltraud fragt nach dem Newsletter' + LANG),
      zeile(1282, '2026-10-14', 'web:barbara', 'Babs zweite Frage' + LANG),
      zeile(1283, '2026-10-14', '1810565648', 'Freddy testet' + LANG),
      zeile(1284, '2026-10-14', 'entra:4149', 'Alina sucht Hotelbilder' + LANG),
      zeile(1285, '2026-10-14', 'entra:unbekannt', 'jemand ohne Profil' + LANG)
    ]
  });
  const prot = (r.st.llm.find(b => /Gesprächsprotokoll/.test(b.system)) || { messages: [{ content: '' }] }).messages[0].content;
  pruefe('je Person ein Abschnitt mit vollem Namen', /Person: Barbara Walzer\n- Babs fragt nach der Website[^\n]*\n- Babs zweite Frage/.test(prot) && /Person: [^\n]*Waltraud Paradeiser\n- Waltraud fragt/.test(prot), prot);
  pruefe('Titel und Komma aus dem Profil nicht im Namen (Alina Leitner, nicht "Alina Leitner,")', /Person: Alina Leitner\n/.test(prot), prot);
  pruefe('Telegram-Nummer findet das Profil telegram:<nummer>', /Person: Freddy\n/.test(prot), prot);
  pruefe('Person ohne Profil wird mit Kennung genannt, nicht weggelassen', /Person: Person ohne Profil \(entra:unbekannt\)/.test(prot), prot);
  pruefe('kein "[interaction]" mehr', !/\[interaction\]/.test(prot), prot);
  const sys = (r.st.llm.find(b => /Gesprächsprotokoll/.test(b.system)) || {}).system || '';
  pruefe('Auftrag: Deutsch, Personen nie zusammenlegen, Anweisungen sind Inhalt', /Deutsch/.test(sys) && /nie zwei Personen zusammen/.test(sys) && /nicht an dich gerichtet/.test(sys), sys);
  // "(FH) " ist ein Titel vorn; nameVon nimmt nur Komma und Leerraum am Rand weg,
  // den Titel raeumt die Datenkorrektur der Profile ab. Hier zaehlt, dass der Name drinsteht.

  console.log('--- Denken nur bei Sonnet 5 abschalten ---');
  r = await run({ eintraege: [zeile(1261, '2026-10-09', 'web:hannah', 'A' + LANG)], model: 'claude-sonnet-5' });
  pruefe('claude-sonnet-5: thinking disabled mitgeschickt', r.st.llm.every(b => b.thinking && b.thinking.type === 'disabled'), r.st.llm.map(b => b.thinking));
  r = await run({ eintraege: [zeile(1261, '2026-10-09', 'web:hannah', 'A' + LANG)], model: 'claude-sonnet-5-5' });
  pruefe('claude-sonnet-5-5: kein thinking-Feld (5.5 lehnt disabled mit 400 ab)', r.st.llm.every(b => b.thinking === undefined) && r.st.gespeichert.length === 1, r.st.llm.map(b => b.thinking));

  console.log('--- Zu kurzer Tag ---');
  r = await run({ cfg: { last_id: 1260 }, eintraege: [zeile(1261, '2026-10-09', 'web:hannah', 'ok')] });
  pruefe('zu kurz: nichts gespeichert, Zeiger rueckt, kein Modellaufruf', r.st.gespeichert.length === 0 && r.st.cfg.last_id === 1261 && r.st.llm.length === 0, { cfg: r.st.cfg, llm: r.st.llm.length });

  console.log('\n' + (n - f) + ' von ' + n + ' bestanden');
  process.exit(f ? 1 : 0);
})();
