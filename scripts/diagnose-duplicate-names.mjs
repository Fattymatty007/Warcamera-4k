#!/usr/bin/env node
// Temporary diagnostic: checks whether Wahapedia's Datasheets.csv genuinely
// contains multiple distinct datasheet rows (different ids) sharing the same
// unit name across different factions — e.g. Nurgle Daemon units also
// available to Death Guard — or whether cross-faction availability is
// represented some other way (a single canonical row plus a separate
// "allowed factions" relation). Determines whether a multi-faction picker
// feature is even meaningful against this data source, and if so, what the
// real duplicate rate looks like. Removed once that's answered.
const BASE = 'https://wahapedia.ru/wh40k11ed';

async function fetchCsv(name) {
  const res = await fetch(`${BASE}/${name}`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; warcamera-4k-diagnostic-bot/1.0)' } });
  if (!res.ok) throw new Error(`Failed to fetch ${name}: ${res.status}`);
  const text = await res.text();
  const lines = text.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0);
  const headers = lines[0].split('|');
  return lines.slice(1).map((line) => {
    const cells = line.split('|');
    const row = {};
    headers.forEach((h, i) => { row[h] = (cells[i] || '').trim(); });
    return row;
  });
}

function normalizeName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function main() {
  const [datasheets, factions] = await Promise.all([
    fetchCsv('Datasheets.csv'),
    fetchCsv('Factions.csv'),
  ]);
  const factionById = new Map(factions.map((f) => [f.id, f.name]));

  const byName = new Map();
  for (const ds of datasheets) {
    if (ds.legend && ds.legend.toLowerCase() === 'true') continue;
    const key = normalizeName(ds.name);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push({ id: ds.id, name: ds.name, faction: factionById.get(ds.faction_id) || ds.faction_id });
  }

  const dupes = [...byName.entries()].filter(([, rows]) => rows.length > 1);
  console.log('Total distinct normalized names:', byName.size);
  console.log('Names with more than one datasheet row:', dupes.length);
  console.log('---- sample of up to 25 duplicate groups ----');
  for (const [key, rows] of dupes.slice(0, 25)) {
    console.log(key, '->', JSON.stringify(rows));
  }

  // Specifically check the user's own example.
  console.log('---- Nurgle-flavored names containing "nurgling" or "plague drone" or "beast of nurgle" or "rotigus" ----');
  for (const [key, rows] of byName.entries()) {
    if (/nurgling|plague drone|beast of nurgle|rotigus|great unclean/.test(key)) {
      console.log(key, '->', JSON.stringify(rows));
    }
  }
}

main().catch((err) => { console.error('diagnose failed:', err.message); process.exit(1); });
