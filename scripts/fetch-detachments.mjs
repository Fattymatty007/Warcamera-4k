#!/usr/bin/env node
// Fetches current, official Warhammer 40,000 11th-edition Detachment data
// (each detachment's own rule, the Enhancements and Stratagems specific to
// it) from Wahapedia's public pipe-delimited CSV data export — same base
// already used by fetch-points.mjs and fetch-datasheets.mjs — and writes a
// static public/detachments-data.json the app reads directly.
//
// This does NOT include faction-wide Army Rules (e.g. Space Marines' "Oath
// of Moment") — confirmed via a CI diagnostic dispatch that no such table
// exists in this export (no Faction_abilities/Army_rules csv, and it isn't
// folded into Detachment_abilities.csv either — every one of its 355 rows
// is tied to a specific detachment). Only Detachment Rules are built here;
// Army Rules would need a different source (out of scope for now).
//
// Run by .github/workflows/update-detachments.yml on a schedule and via
// manual dispatch — mirrors update-datasheets.yml exactly (self-triggers
// the Pages deploy after committing, since a push using the default
// GITHUB_TOKEN doesn't trigger other workflows on its own).
import { writeFile } from 'node:fs/promises';

const BASE = 'https://wahapedia.ru/wh40k11ed';

async function fetchCsv(name) {
  const res = await fetch(`${BASE}/${name}`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; warcamera-4k-detachments-bot/1.0)' } });
  if (!res.ok) throw new Error(`Failed to fetch ${name}: ${res.status}`);
  const text = await res.text();
  const lines = text.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0);
  const headers = lines[0].split('|');
  const rows = lines.slice(1).map((line) => {
    const cells = line.split('|');
    const row = {};
    headers.forEach((h, i) => { row[h] = (cells[i] || '').trim(); });
    return row;
  });
  console.log(`${name}: ${rows.length} rows, columns: ${headers.join(', ')}`);
  return rows;
}

// Wahapedia's "legend" column means different things in different tables —
// a true/false Warhammer-Legends flag on Datasheets.csv, but flavor-text
// on Stratagems.csv/Detachment_abilities.csv/Enhancements.csv (confirmed
// via the same diagnostic dispatch — zero rows in any of the three had
// legend=true). No Legends filtering is needed here for that reason; the
// edition-scoped /wh40k11ed/ export already doesn't include retired
// content, same as already relied on for the datasheets pipeline.
function stripHtml(s) {
  return (s || '').replace(/<[^>]+>/g, '').replace(/\s{2,}/g, ' ').trim();
}

function normalizeName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const k = row[key];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  }
  return map;
}

async function main() {
  const [factions, detachments, detachmentAbilities, enhancements, stratagems] = await Promise.all([
    fetchCsv('Factions.csv'),
    fetchCsv('Detachments.csv'),
    fetchCsv('Detachment_abilities.csv'),
    fetchCsv('Enhancements.csv'),
    fetchCsv('Stratagems.csv'),
  ]);

  const factionById = new Map(factions.map((f) => [f.id, f.name]));
  const abilityByDetachmentId = new Map(detachmentAbilities.map((a) => [a.detachment_id, a]));
  const enhancementsByDetachmentId = groupBy(enhancements, 'detachment_id');
  // "Boarding Actions" stratagems belong to a separate, smaller-scale 40k
  // game mode with its own rules set — not what a normal army list uses.
  const stratagemsByDetachmentId = groupBy(
    stratagems.filter((s) => !(s.type || '').startsWith('Boarding Actions')),
    'detachment_id',
  );

  const factionsOut = {};
  let detachmentCount = 0;

  for (const d of detachments) {
    if (!d.name || !d.faction_id) continue;
    const factionName = factionById.get(d.faction_id);
    if (!factionName) continue;

    // Description fields keep their <br>/<li> structure intact (only
    // trimmed, not stripped) — these are multi-line/bulleted rules text
    // (a stratagem's WHEN/TARGET/EFFECT layout, a detachment ability's
    // bullet-point options), unlike the short one-line datasheet abilities
    // fetch-datasheets.mjs strips down to plain text. The app's
    // htmlToPlainText() converts this to readable line breaks and bullets
    // at render time instead of losing that structure here.
    const ability = abilityByDetachmentId.get(d.id);
    const dEnhancements = (enhancementsByDetachmentId.get(d.id) || []).map((e) => ({
      name: stripHtml(e.name),
      cost: e.cost || '',
      description: (e.description || '').trim(),
    }));
    const dStratagems = (stratagemsByDetachmentId.get(d.id) || []).map((s) => ({
      name: stripHtml(s.name),
      cpCost: s.cp_cost || '',
      type: stripHtml(s.type),
      turn: stripHtml(s.turn),
      phase: stripHtml(s.phase),
      description: (s.description || '').trim(),
    }));

    // force_disposition — one of a fixed set (Purge the Foe, Take and
    // Hold, Reconnaissance, Priority Assets, Disruption) assigned to each
    // Detachment directly by the rules, not something a player chooses —
    // this is what the app calls a Detachment's "Deposition". Blank for
    // Boarding Actions-type detachments (a separate, smaller-scale game
    // mode this app already excludes stratagems for above).
    const record = {
      displayName: stripHtml(d.name),
      faction: factionName,
      disposition: stripHtml(d.force_disposition),
      ability: ability ? { name: stripHtml(ability.name), description: (ability.description || '').trim() } : null,
      enhancements: dEnhancements,
      stratagems: dStratagems,
    };

    const factionKey = normalizeName(factionName);
    if (!factionsOut[factionKey]) factionsOut[factionKey] = { displayName: factionName, detachments: {} };
    const detachmentKey = normalizeName(record.displayName);
    if (!detachmentKey) continue;
    factionsOut[factionKey].detachments[detachmentKey] = record;
    detachmentCount++;
  }

  const factionCount = Object.keys(factionsOut).length;
  console.log('Detachments kept:', detachmentCount, 'across', factionCount, 'factions');
  if (detachmentCount < 100) {
    console.error(`Suspiciously few detachments (${detachmentCount}) — join logic likely needs tuning.`);
  }

  const out = {
    version: 'wh40k11ed',
    sourceUrl: `${BASE}/the-rules/data-export/`,
    updatedAt: new Date().toISOString(),
    detachmentCount,
    factions: factionsOut,
  };

  await writeFile(new URL('../public/detachments-data.json', import.meta.url), JSON.stringify(out) + '\n');
  console.log('Wrote public/detachments-data.json');
}

main().catch((err) => {
  console.error('fetch-detachments failed:', err.message);
  process.exit(1);
});
