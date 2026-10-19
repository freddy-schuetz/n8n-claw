// Runde 10 (19.10.2026): die Weboberflaeche zeigt den Auftrag eines geplanten
// Laufs (Erinnerung mit Auftrag, Nachfrage zu offenen Vorhaben) nicht mehr als
// Nachricht der Person, nur Ruperts Antwort. Das Blaettern bleibt vollstaendig:
// die Oberflaeche laedt weiter, solange genau limit Nachrichten kommen.
// Der ECHTE Code des Knotens "Read History" laeuft gegen nachgebaute Zeilen.
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const wf = JSON.parse(fs.readFileSync(path.join(REPO, 'workflows/agent-history.json'), 'utf8'));
const CODE = wf.nodes.find(n => n.name === 'Read History').parameters.jsCode
  .replace(/\{\{SUPABASE_URL\}\}/g, 'http://stub.local')
  .replace(/\{\{SUPABASE_SERVICE_KEY\}\}/g, 'stub-key');

// 100 Zeilen, Ids 1..100; alle 10 eine geplante Auftragszeile
function zeilen() {
  const z = [];
  for (let id = 1; id <= 100; id++) {
    const geplant = id % 10 === 0;
    z.push({ id, role: geplant ? 'user' : (id % 2 ? 'user' : 'assistant'), content: 'Zeile ' + id, created_at: '2026-10-19T08:00:00Z',
      metadata: geplant ? { source: id % 20 === 0 ? 'scheduled_task' : 'scheduled_action' } : (id === 3 ? null : { source: 'web' }) });
  }
  return z;
}

async function run(query) {
  const urls = [];
  const alle = zeilen();
  const helpers = {
    async httpRequest(o) {
      const url = String(o.url || '');
      urls.push(url);
      const lim = Number(url.split('limit=')[1].split('&')[0]);
      const vor = url.includes('&id=lt.') ? Number(url.split('&id=lt.')[1].split('&')[0]) : Infinity;
      return alle.filter(r => r.id < vor).sort((a, b) => b.id - a.id).slice(0, lim);
    }
  };
  const $ = () => ({ first: () => ({ json: { query } }) });
  const fn = new AsyncFunction('$', 'helpers', CODE + '\n//# sourceURL=agent-history.js');
  const out = await fn($, helpers);
  return { out: out[0].json, urls };
}

let n = 0, f = 0;
function pruefe(name, ok, info) { n++; if (!ok) f++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  -> ' + JSON.stringify(info).slice(0, 400))); }

(async () => {
  let r = await run({ session_id: 'web:florian', limit: '30' });
  const ids = r.out.messages.map(m => m.id);
  pruefe('holt die doppelte Menge mit metadata', /limit=60/.test(r.urls[0]) && /select=id,role,content,created_at,metadata/.test(r.urls[0]), r.urls);
  pruefe('genau 30 Nachrichten, damit die Oberflaeche weiterblaettert', r.out.messages.length === 30, r.out.messages.length);
  pruefe('keine geplante Auftragszeile', !ids.some(id => id % 10 === 0), ids);
  pruefe('die neuesten, aufsteigend sortiert', ids[ids.length - 1] === 99 && ids.every((x, i) => i === 0 || x > ids[i - 1]), ids);
  pruefe('oldest_id ist die aelteste gelieferte Nachricht', r.out.oldest_id === ids[0], { oldest: r.out.oldest_id, erste: ids[0] });
  pruefe('Felder wie bisher (id, role, content, created_at), metadata nicht nach aussen', r.out.messages.every(m => Object.keys(m).join() === 'id,role,content,created_at'), r.out.messages[0]);

  // Ganze Historie durchblaettern: jede sichtbare Zeile genau einmal
  const gesehen = [];
  let vor = null, runden = 0, mehr = true;
  while (mehr && runden < 10) {
    runden++;
    const q = { session_id: 'web:florian', limit: '30' };
    if (vor) q.before_id = String(vor);
    const s = await run(q);
    gesehen.unshift(...s.out.messages.map(m => m.id));
    mehr = s.out.messages.length >= 30;
    vor = s.out.oldest_id;
  }
  const soll = zeilen().filter(z => z.id % 10 !== 0).map(z => z.id);
  pruefe('Blaettern: alle 90 sichtbaren Zeilen genau einmal, keine Luecke', gesehen.join() === soll.join(), { gesehen: gesehen.length, soll: soll.length });
  pruefe('Zeile ohne metadata (alter Stand) bleibt sichtbar', gesehen.includes(3), gesehen.slice(0, 5));

  r = await run({ session_id: '' });
  pruefe('ohne Sitzung: leer wie bisher', Array.isArray(r.out.messages) && r.out.messages.length === 0 && r.urls.length === 0, r);

  console.log('\n' + (n - f) + ' von ' + n + ' bestanden');
  process.exit(f ? 1 : 0);
})();
