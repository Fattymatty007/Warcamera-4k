#!/usr/bin/env node
// Temporary diagnostic: checks whether Wahapedia's public data export
// (same base used by fetch-points.mjs / fetch-datasheets.mjs) includes
// faction-wide Army Rules and per-detachment rules/enhancements/stratagems
// data, and if so what shape it's in — before designing a fetch pipeline
// and a Collection-folder feature around it. wahapedia.ru is unreachable
// from this dev sandbox, so this has to run from CI. Removed once answered.
const BASE = 'https://wahapedia.ru/wh40k11ed';

async function tryFetch(name) {
  try {
    const res = await fetch(`${BASE}/${name}`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; warcamera-4k-diagnostic-bot/1.0)' } });
    if (!res.ok) return { name, ok: false, status: res.status };
    const text = await res.text();
    const lines = text.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0);
    return { name, ok: true, rowCount: lines.length - 1, headers: lines[0] ? lines[0].split('|') : [], sampleRows: lines.slice(1, 4) };
  } catch (err) {
    return { name, ok: false, error: err.message };
  }
}

async function main() {
  // Guessing likely filenames based on Wahapedia's existing naming
  // convention (Datasheets.csv, Datasheets_abilities.csv, Abilities.csv,
  // Datasheets_keywords.csv, Datasheets_unit_composition.csv, Factions.csv).
  const candidates = [
    'Stratagems.csv',
    'Enhancements.csv',
    'Detachment_abilities.csv',
    'Detachments.csv',
    'Source.csv',
    'Datasheets_stratagems.csv',
    'Last_update.csv',
  ];
  const results = await Promise.all(candidates.map(tryFetch));
  for (const r of results) {
    console.log('----', r.name, '----');
    if (!r.ok) {
      console.log('  NOT FOUND / ERROR:', r.status || r.error);
      continue;
    }
    console.log('  rows:', r.rowCount);
    console.log('  columns:', r.headers.join(' | '));
    console.log('  sample:');
    r.sampleRows.forEach((row) => console.log('   ', row));
  }

  // Also check Factions.csv for any rules-text-shaped columns we might have
  // missed when we only used id/name from it previously.
  const factions = await tryFetch('Factions.csv');
  console.log('\n---- Factions.csv (full columns) ----');
  if (factions.ok) {
    console.log('  columns:', factions.headers.join(' | '));
    factions.sampleRows.forEach((row) => console.log('   ', row));
  } else {
    console.log('  NOT FOUND / ERROR:', factions.status || factions.error);
  }
}

main().catch((err) => { console.error('diagnose failed:', err.message); process.exit(1); });
