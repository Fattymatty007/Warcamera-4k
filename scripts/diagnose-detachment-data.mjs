#!/usr/bin/env node
// Round 3: rounds 1-2 confirmed Detachments.csv, Detachment_abilities.csv,
// Enhancements.csv, Stratagems.csv exist, but no dedicated Faction_abilities/
// Army_rules csv exists (all 404). This checks whether the single faction-
// wide "Army Rule" (e.g. Space Marines' "Oath of Moment") is instead folded
// into Detachment_abilities.csv as a row with an empty "detachment" field —
// Wahapedia's per-faction pages do show it above the per-detachment list,
// so it may just live in the same table without a detachment tag.
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

async function main() {
  const [detAbilities, factions] = await Promise.all([
    fetchCsv('Detachment_abilities.csv'),
    fetchCsv('Factions.csv'),
  ]);
  const factionById = new Map(factions.map((f) => [f.id, f.name]));

  const emptyDetachment = detAbilities.filter((r) => !r.detachment);
  console.log('Detachment_abilities.csv rows with EMPTY detachment field:', emptyDetachment.length, '/', detAbilities.length);
  emptyDetachment.slice(0, 15).forEach((r) => console.log('  ', factionById.get(r.faction_id) || r.faction_id, '->', r.name));

  // Group by faction_id, show how many rows each has and whether any lack
  // a detachment value.
  const byFaction = new Map();
  for (const r of detAbilities) {
    if (!byFaction.has(r.faction_id)) byFaction.set(r.faction_id, []);
    byFaction.get(r.faction_id).push(r);
  }
  console.log('\nPer-faction row counts (first 10 factions):');
  let i = 0;
  for (const [fid, rows] of byFaction) {
    if (i++ >= 10) break;
    const noDetach = rows.filter((r) => !r.detachment).map((r) => r.name);
    console.log('  ', factionById.get(fid) || fid, '- total rows:', rows.length, '| no-detachment rows:', JSON.stringify(noDetach));
  }

  // Specifically look for Space Marines' known army rule "Oath of Moment".
  const oath = detAbilities.filter((r) => r.name && r.name.toLowerCase().includes('oath of moment'));
  console.log('\n"Oath of Moment" rows (', oath.length, '):');
  oath.forEach((r) => console.log('  ', JSON.stringify({ faction: factionById.get(r.faction_id) || r.faction_id, name: r.name, detachment: r.detachment })));

  // And Death Guard's (a faction from earlier in this session).
  const dg = [...byFaction.entries()].find(([fid, rows]) => (factionById.get(fid) || '').toLowerCase() === 'death guard');
  if (dg) {
    console.log('\nDeath Guard Detachment_abilities rows:');
    dg[1].forEach((r) => console.log('  ', JSON.stringify({ name: r.name, detachment: r.detachment })));
  }
}

main().catch((err) => { console.error('diagnose failed:', err.message); process.exit(1); });
