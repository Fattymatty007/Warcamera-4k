#!/usr/bin/env node
// Fetches current, official Warhammer 40,000 11th-edition datasheets (stats,
// weapons, abilities, keywords, unit composition) from Wahapedia's public
// pipe-delimited CSV data export — the same export every serious third-party
// 40k app relies on, offered specifically for this purpose (see
// https://wahapedia.ru/wh40k11ed/the-rules/data-export/) — and writes a
// static public/datasheets-data.json the app reads directly, same pattern
// as public/points-data.json (see scripts/fetch-points.mjs). Preferred over
// Gemini's own knowledge whenever a unit matches: Gemini's training data
// blends multiple editions' worth of Warhammer content with no reliable way
// to tell current-11e content apart from retired weapon options or old stat
// lines, and a visitor's own (usually unbilled, non-grounded) API key has no
// way to verify itself against anything current at all. This removes the
// model from the stats pipeline entirely for any unit found here, so the
// same unit produces the same, correct answer regardless of whose key asked.
//
// Run by .github/workflows/update-datasheets.yml on a schedule and via
// manual dispatch — mirrors update-points.yml exactly (self-triggers the
// Pages deploy after committing, since a push using the default
// GITHUB_TOKEN doesn't trigger other workflows on its own).
import { writeFile } from 'node:fs/promises';

const BASE = 'https://wahapedia.ru/wh40k11ed';

async function fetchCsv(name) {
  const res = await fetch(`${BASE}/${name}`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; warcamera-4k-datasheets-bot/1.0)' } });
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
  const [datasheets, factions, models, wargear, abilitiesRows, abilitiesRef, keywords, composition] = await Promise.all([
    fetchCsv('Datasheets.csv'),
    fetchCsv('Factions.csv'),
    fetchCsv('Datasheets_models.csv'),
    fetchCsv('Datasheets_wargear.csv'),
    fetchCsv('Datasheets_abilities.csv'),
    fetchCsv('Abilities.csv'),
    fetchCsv('Datasheets_keywords.csv'),
    fetchCsv('Datasheets_unit_composition.csv'),
  ]);

  const factionById = new Map(factions.map((f) => [f.id, f.name]));
  const abilityRefById = new Map(abilitiesRef.map((a) => [a.id, a]));
  const modelsByDs = groupBy(models, 'datasheet_id');
  const wargearByDs = groupBy(wargear, 'datasheet_id');
  const abilitiesByDs = groupBy(abilitiesRows, 'datasheet_id');
  const keywordsByDs = groupBy(keywords, 'datasheet_id');
  const compositionByDs = groupBy(composition, 'datasheet_id');

  const units = {};
  let skippedLegend = 0;
  let skippedNoModels = 0;

  for (const ds of datasheets) {
    // Warhammer Legends datasheets are retired/legacy content, not part of
    // current 11th-edition play — excluding them is the direct fix for
    // "stats pages showing options that aren't available in 11th edition."
    if (ds.legend && ds.legend.toLowerCase() === 'true') { skippedLegend++; continue; }

    const dsModels = (modelsByDs.get(ds.id) || []).sort((a, b) => Number(a.line) - Number(b.line));
    if (dsModels.length === 0) { skippedNoModels++; continue; }
    const primary = dsModels[0];

    const dsWargear = (wargearByDs.get(ds.id) || []).sort((a, b) => Number(a.line) - Number(b.line));
    const weapons = dsWargear.map((w) => ({
      name: stripHtml(w.name),
      type: w.type || '',
      range: /^\d+$/.test((w.range || '').trim()) ? `${w.range}"` : (w.range || 'Melee'),
      attacks: stripHtml(w.A),
      skill: stripHtml(w.BS_WS),
      strength: stripHtml(w.S),
      ap: stripHtml(w.AP),
      damage: stripHtml(w.D),
      abilities: stripHtml(w.description),
    }));

    const dsAbilities = (abilitiesByDs.get(ds.id) || []).sort((a, b) => Number(a.line) - Number(b.line));
    const abilities = [];
    const seenAbilityNames = new Set();
    for (const a of dsAbilities) {
      let name = stripHtml(a.name);
      let description = stripHtml(a.description);
      if (!name && a.ability_id && abilityRefById.has(a.ability_id)) {
        const ref = abilityRefById.get(a.ability_id);
        name = stripHtml(ref.name);
        description = stripHtml(ref.description);
      }
      if (!name || seenAbilityNames.has(name)) continue;
      seenAbilityNames.add(name);
      abilities.push({ name, description });
    }

    const dsKeywords = keywordsByDs.get(ds.id) || [];
    const keywordList = [];
    const factionKeywordList = [];
    for (const k of dsKeywords) {
      const kw = stripHtml(k.keyword);
      if (!kw) continue;
      if (k.is_faction_keyword && k.is_faction_keyword.toLowerCase() === 'true') factionKeywordList.push(kw);
      else keywordList.push(kw);
    }

    const dsComposition = (compositionByDs.get(ds.id) || []).sort((a, b) => Number(a.line) - Number(b.line));
    const unitComposition = dsComposition.map((c) => stripHtml(c.description)).filter(Boolean).join('; ');

    const record = {
      displayName: stripHtml(ds.name),
      faction: factionById.get(ds.faction_id) || '',
      unit_composition: unitComposition,
      stats: {
        movement: stripHtml(primary.M),
        toughness: stripHtml(primary.T),
        save: stripHtml(primary.Sv),
        wounds: stripHtml(primary.W),
        leadership: stripHtml(primary.Ld),
        oc: stripHtml(primary.OC),
        invulnerable_save: primary.inv_sv ? stripHtml(primary.inv_sv) : null,
      },
      weapons,
      abilities,
      keywords: keywordList,
      faction_keywords: factionKeywordList,
    };

    // Some units have a genuinely separate datasheet per faction that can
    // take them — e.g. Nurgle Daemon units like Nurglings or Plague Drones
    // have their own row under both Chaos Daemons and Death Guard — so this
    // keeps every variant under the same name key instead of letting later
    // ones silently overwrite earlier ones. The app decides what to do with
    // more than one (ask which faction) once it has all of them.
    const key = normalizeName(record.displayName);
    if (key) {
      if (!units[key]) units[key] = [];
      units[key].push(record);
    }
  }

  const count = Object.keys(units).length;
  const variantCount = Object.values(units).reduce((sum, v) => sum + v.length, 0);
  console.log('Datasheets kept:', variantCount, 'across', count, 'unit names (', variantCount - count, 'multi-faction duplicates ) | skipped as Legends:', skippedLegend, '| skipped (no model line):', skippedNoModels);
  if (count < 500) {
    console.error(`Suspiciously few datasheets (${count}) — join logic likely needs tuning.`);
  }

  const out = {
    version: 'wh40k11ed',
    sourceUrl: `${BASE}/the-rules/data-export/`,
    updatedAt: new Date().toISOString(),
    unitCount: count,
    units,
  };

  await writeFile(new URL('../public/datasheets-data.json', import.meta.url), JSON.stringify(out) + '\n');
  console.log('Wrote public/datasheets-data.json');
}

main().catch((err) => {
  console.error('fetch-datasheets failed:', err.message);
  process.exit(1);
});
