#!/usr/bin/env node
// Round 2: found Detachments.csv, Detachment_abilities.csv, Enhancements.csv,
// Stratagems.csv in round 1 — now finding the missing piece (faction-wide
// Army Rules) and understanding how to filter Stratagems.csv down to real,
// current-edition, non-game-mode-specific content (the "type" field mixed
// stratagem category with a game-mode-sounding prefix like "Boarding
// Actions –" in the round-1 sample).
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

async function tryFetch(name) {
  try {
    const rows = await fetchCsv(name);
    return { name, ok: true, rows };
  } catch (err) {
    return { name, ok: false, error: err.message };
  }
}

async function main() {
  const candidates = ['Faction_abilities.csv', 'Army_rules.csv', 'Faction_rules.csv', 'Faction_ability.csv'];
  for (const name of candidates) {
    const r = await tryFetch(name);
    console.log('----', name, '----');
    if (!r.ok) { console.log('  NOT FOUND:', r.error); continue; }
    console.log('  rows:', r.rows.length, '| columns:', Object.keys(r.rows[0] || {}).join(' | '));
    r.rows.slice(0, 3).forEach((row) => console.log('   ', JSON.stringify(row)));
  }

  // Stratagems.csv deep-dive: distinct "type" values, how many rows have an
  // empty detachment (implying core/faction-wide vs detachment-specific),
  // and specifically look for well-known universal stratagems by name.
  const strats = await fetchCsv('Stratagems.csv');
  const typeCounts = {};
  for (const s of strats) typeCounts[s.type] = (typeCounts[s.type] || 0) + 1;
  console.log('\n---- Stratagems.csv: distinct "type" values (count) ----');
  Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).slice(0, 30).forEach(([t, c]) => console.log('  ', c, t));

  const emptyDetach = strats.filter((s) => !s.detachment);
  console.log('\nRows with EMPTY detachment field:', emptyDetach.length, '/', strats.length);
  console.log('Sample of empty-detachment rows:');
  emptyDetach.slice(0, 5).forEach((s) => console.log('  ', JSON.stringify({ name: s.name, faction_id: s.faction_id, type: s.type, legend: s.legend })));

  const commandReroll = strats.filter((s) => s.name && s.name.toLowerCase().includes('command re-roll'));
  console.log('\nAll "Command Re-roll" rows (', commandReroll.length, '):');
  commandReroll.forEach((s) => console.log('  ', JSON.stringify({ name: s.name, faction_id: s.faction_id, type: s.type, detachment: s.detachment, legend: s.legend })));

  const legendCounts = { true: 0, false: 0, other: 0 };
  for (const s of strats) {
    const v = (s.legend || '').toLowerCase();
    if (v === 'true') legendCounts.true++;
    else if (v === 'false' || v === '') legendCounts.false++;
    else legendCounts.other++;
  }
  console.log('\nStratagems legend field breakdown:', JSON.stringify(legendCounts));

  // Same legend breakdown for Detachment_abilities and Enhancements.
  const detAbilities = await fetchCsv('Detachment_abilities.csv');
  const enh = await fetchCsv('Enhancements.csv');
  for (const [label, rows] of [['Detachment_abilities', detAbilities], ['Enhancements', enh]]) {
    const counts = { true: 0, false: 0, other: 0 };
    for (const r of rows) {
      const v = (r.legend || '').toLowerCase();
      if (v === 'true') counts.true++;
      else if (v === 'false' || v === '') counts.false++;
      else counts.other++;
    }
    console.log(label, 'legend field breakdown:', JSON.stringify(counts));
  }

  // Confirm faction_id values line up with Factions.csv ids (join key check).
  const factions = await fetchCsv('Factions.csv');
  console.log('\nSample Factions.csv ids:', factions.slice(0, 8).map((f) => f.id + '=' + f.name).join(', '));
}

main().catch((err) => { console.error('diagnose failed:', err.message); process.exit(1); });
