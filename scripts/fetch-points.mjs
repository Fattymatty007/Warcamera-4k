#!/usr/bin/env node
// Fetches current Warhammer 40,000 points from the BSData community's
// Munitorum Field Manual snapshots (github.com/BSData/wh40k-11e-mfm) and
// extracts unit-name -> points-cost pairs into public/points-data.json.
// Same static, zero-Gemini-call, no-browser pattern as the other fetch-*
// scripts.
//
// Why this source (changed 2026-10-10, Matt's call): the app previously
// scraped per-datasheet points tables from Wahapedia, but Wahapedia's 11e
// costs lag real balance updates (its 11e export is still largely seeded
// from 10e values), so the app kept showing stale points. New Recruit's
// data files are maintained by the BSData community on GitHub, and the
// points in them originate from Games Workshop's official Munitorum Field
// Manual — the wh40k-11e-mfm repo is a bot-maintained, MIT-licensed parse
// of that manual (mfm.warhammer-community.com) into one clean YAML file
// per faction, re-scraped daily upstream. Pulling points from there puts
// this app's search results on the same values New Recruit shows, without
// having to reimplement BattleScribe catalogue cost logic (entry links,
// conditional modifiers, per-chapter pricing) from wh40k-11e itself.
//
// Each faction file's `units:` list carries, per unit, a `pricing:` list
// of requisition tiers (range "[1,)" = every copy costs the same; "[1,2]"
// then "[3,)" = the 11e 1st–2nd / 3rd+ unit pricing) whose `costs:` give
// { models, points } per unit size, with an optional `desc` for composite
// units and `addon: true` for optional add-on models. Legends units
// (`legends: true`) are INCLUDED: New Recruit shows them with points, and
// the old Wahapedia pipeline showed points for most of them too — a
// search that finds no points at all is worse than one that finds a
// Legends unit's cost.
//
// The YAML is machine-emitted in a deterministic shape by that repo, so a
// small indentation-aware line parser is enough — no YAML dependency,
// keeping this script runnable with plain `node` in CI like the others.
// Anything that doesn't parse the expected way is logged loudly and the
// run fails if coverage collapses, rather than silently shipping gaps.
import { writeFile } from 'node:fs/promises';

const REPO = 'BSData/wh40k-11e-mfm';
const API_CONTENTS = `https://api.github.com/repos/${REPO}/contents/data`;
const SOURCE_URL = `https://github.com/${REPO}`;
const UA = { 'User-Agent': 'warcamera-4k-points-bot/1.0' };

function normalizeName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Strip one level of YAML quoting (double quotes with \" escapes, or
// single quotes with '' escapes) if present.
function unquote(s) {
  const t = (s || '').trim();
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
    try { return JSON.parse(t); } catch { return t.slice(1, -1); }
  }
  if (t.length >= 2 && t[0] === "'" && t[t.length - 1] === "'") {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  return t;
}

const ORDINALS = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th', 6: '6th' };
function ordinal(n) { return ORDINALS[n] || `${n}th`; }

// A pricing tier's range interval -> short qualifier for the display
// string. "[1,)" covers every copy of the unit, so it needs no qualifier;
// "[1,2]" / "[3,)" are the 11e requisition tiers ("1st–2nd" / "3rd+").
function tierQualifier(range) {
  const m = /^\[\s*(\d+)\s*,\s*(\d*)\s*\)$/.exec(range || '');
  if (!m) return '';
  const lo = Number(m[1]);
  const hi = m[2] === '' ? Infinity : Number(m[2]);
  if (lo <= 1 && hi === Infinity) return '';
  if (hi === Infinity) return `${ordinal(lo)}+`;
  if (lo === hi) return ordinal(lo);
  return `${ordinal(lo)}–${ordinal(hi)}`;
}

// Parse one flow-style cost map: { models: 6, points: 115, desc: ... ,
// addon: true }. models/points are plain integers; desc is free text that
// may itself contain commas, so it's captured as "everything after
// `desc:` up to `, addon:` or the closing brace".
function parseCostFlow(text) {
  const inner = text.trim().replace(/^\{\s*/, '').replace(/\s*\}\s*$/, '');
  const models = /(?:^|,\s*)models:\s*(\d+)/.exec(inner);
  const points = /(?:^|,\s*)points:\s*([\d,]+)/.exec(inner);
  if (!models || !points) return null;
  let desc = '';
  const descMatch = /(?:^|,\s*)desc:\s*(.+?)(?:,\s*addon:|\s*$)/.exec(inner);
  if (descMatch) desc = unquote(descMatch[1].replace(/,\s*$/, ''));
  const addon = /(?:^|,\s*)addon:\s*true/.test(inner);
  return { models: Number(models[1]), points: Number(points[1].replace(/,/g, '')), desc, addon };
}

// Parse one faction file's `units:` section into
// [{ name, legends, tiers: [{ range, costs: [cost, ...] }] }].
function parseFactionUnits(yaml) {
  const lines = yaml.split('\n');
  const factionName = (() => {
    const l = lines.find((x) => /^name:\s*/.test(x));
    return l ? unquote(l.replace(/^name:\s*/, '')) : '';
  })();
  const start = lines.findIndex((l) => /^units:\s*$/.test(l));
  if (start === -1) return { factionName, units: [] };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[^\s]/.test(lines[i]) && lines[i].trim() !== '') { end = i; break; }
  }
  const units = [];
  let unit = null;
  let tier = null;
  let inCosts = false;
  for (let i = start + 1; i < end; i++) {
    const line = lines[i];
    let m;
    if ((m = /^  - name:\s*(.+)$/.exec(line))) {
      unit = { name: unquote(m[1]), legends: false, tiers: [] };
      units.push(unit);
      tier = null; inCosts = false;
    } else if (unit && /^    legends:\s*true/.test(line)) {
      unit.legends = true;
    } else if (unit && /^      - range:\s*(.+)$/.exec(line)) {
      tier = { range: unquote(RegExp.$1), costs: [] };
      unit.tiers.push(tier);
      inCosts = false;
    } else if (unit && /^        costs:\s*$/.test(line)) {
      inCosts = true;
    } else if (unit && inCosts && (m = /^          - (\{.*\})\s*$/.exec(line))) {
      const cost = parseCostFlow(m[1]);
      if (cost && tier) tier.costs.push(cost);
    } else if (/^        [a-zA-Z]/.test(line) || /^      - /.test(line) || /^    [a-zA-Z]/.test(line)) {
      // Any other key at costs-level or above ends the costs block (e.g. a
      // unit's `wargear:` section, which carries its own per-item costs
      // that are not the unit's price and stay excluded).
      if (!/^      - range:/.test(line)) inCosts = false;
    }
  }
  return { factionName, units };
}

// The same display shape the old pipeline produced — "115 pts (10 models)"
// segments joined with " / " — extended with the requisition-tier
// qualifier only when a unit actually has tiered pricing.
function formatPoints(unit) {
  const segments = [];
  for (const tier of unit.tiers) {
    const q = tierQualifier(tier.range);
    for (const c of tier.costs) {
      if (c.addon) {
        segments.push(`+${c.points} pts (${c.desc || 'add-on'})`);
      } else if (c.desc) {
        segments.push(`${c.points} pts (${c.desc}${q ? `, ${q}` : ''})`);
      } else {
        segments.push(`${c.points} pts (${c.models} model${c.models === 1 ? '' : 's'}${q ? `, ${q}` : ''})`);
      }
    }
  }
  return [...new Set(segments)].join(' / ');
}

async function main() {
  const listRes = await fetch(API_CONTENTS, { headers: { ...UA, Accept: 'application/vnd.github+json' } });
  if (!listRes.ok) throw new Error(`Failed to list ${API_CONTENTS}: ${listRes.status}`);
  const files = (await listRes.json())
    .filter((f) => f.type === 'file' && /\.ya?ml$/i.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  console.log('Faction files:', files.length);
  if (files.length < 10) throw new Error(`Suspiciously few faction files (${files.length}) — repo layout likely changed.`);

  const units = {};
  let parsedUnits = 0;
  let legendsIncluded = 0;
  const unparsed = [];
  for (const f of files) {
    const res = await fetch(f.download_url, { headers: UA });
    if (!res.ok) throw new Error(`Failed to fetch ${f.name}: ${res.status}`);
    const { factionName, units: factionUnits } = parseFactionUnits(await res.text());
    for (const u of factionUnits) {
      const points = formatPoints(u);
      if (!points) { unparsed.push(`${factionName}: ${u.name}`); continue; }
      parsedUnits++;
      if (u.legends) legendsIncluded++;
      const key = normalizeName(u.name);
      if (!key) continue;
      const existing = units[key];
      if (existing) {
        // The same unit can appear under several factions (shared Space
        // Marines units in chapter files, Daemons in god legions, ...) —
        // occasionally at chapter-specific prices. Merge differing cost
        // segments into the one name-keyed entry the app looks up by,
        // rather than letting file order silently pick a winner.
        const merged = [...new Set([...existing.points.split(' / '), ...points.split(' / ')])];
        existing.points = merged.join(' / ');
      } else {
        units[key] = { displayName: u.name, points, faction: factionName };
      }
    }
  }

  const count = Object.keys(units).length;
  console.log('Units parsed:', parsedUnits, '/ of which Legends:', legendsIncluded, '/ unique unit entries:', count);
  if (unparsed.length) console.warn('Units with pricing but no parsed costs:', unparsed.slice(0, 20).join('; '), unparsed.length > 20 ? `(+${unparsed.length - 20} more)` : '');
  if (count < 500) {
    console.error(`Suspiciously few units with points (${count}) — extraction likely needs tuning.`);
    process.exit(1);
  }

  const out = {
    version: 'wh40k11ed',
    source: 'BSData/wh40k-11e-mfm (Munitorum Field Manual snapshots — the BSData data behind New Recruit)',
    sourceUrl: SOURCE_URL,
    updatedAt: new Date().toISOString(),
    unitCount: count,
    units,
  };

  await writeFile(new URL('../public/points-data.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
  console.log('Wrote public/points-data.json');
}

main().catch((err) => {
  console.error('fetch-points failed:', err.message);
  process.exit(1);
});
