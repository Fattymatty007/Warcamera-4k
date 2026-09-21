#!/usr/bin/env node
// Fetches current Warhammer 40,000 points from Wahapedia's public
// 11th-edition data export/site and extracts unit-name -> points-cost pairs
// into public/points-data.json. Same static, zero-Gemini-call, no-browser
// pattern as fetch-datasheets.mjs/fetch-detachments.mjs — reused for
// consistency and because it doesn't touch Games Workshop's own site.
//
// Previously scraped GW's own Munitorum Field Manual web app directly
// (mfm.warhammer-community.com) via a headless browser — replaced with this
// after confirming, via a broad sample comparison against that GW-sourced
// data, that Wahapedia's own per-datasheet points tables are accurate
// (28/31 exact matches across a 45-unit sample spanning every faction; the
// handful of mismatches were small and plausibly just Wahapedia lagging a
// very recent points update, not a systemic problem).
//
// Unlike Datasheets.csv/Datasheets_models.csv (no points column at all —
// confirmed via a CI diagnostic dispatch, and no dedicated Points.csv
// exists either), points only show up in the *rendered* per-datasheet page
// each row's own `link` column already points to — inside a
// `dsUnitCostHeader`-labelled table of `N models` / `<div class="PriceTag">
// P</div>` row pairs. No headless browser is needed for this despite being
// HTML rather than a CSV — the cost table is present in the raw response,
// not rendered client-side afterward, unlike GW's own Next.js MFM app.
// That means one plain fetch per datasheet (~1,660 of them) instead of a
// slow per-faction Playwright crawl — done in small concurrent batches
// below to keep it reasonably fast without hammering the site.
import { writeFile } from 'node:fs/promises';

const BASE = 'https://wahapedia.ru/wh40k11ed';
const CONCURRENCY = 15;

async function fetchCsv(name) {
  const res = await fetch(`${BASE}/${name}`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; warcamera-4k-points-bot/1.0)' } });
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
  console.log(`${name}: ${rows.length} rows`);
  return rows;
}

function normalizeName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Whitespace-tolerant on purpose — a tight, no-whitespace version of this
// regex silently dropped some of a unit's cost tiers on plenty of real
// pages during validation, apparently depending on incidental formatting
// differences in Wahapedia's own markup between datasheets.
const COST_PAIR_RE = /<td>\s*(\d+)\s*models?\s*<\/td>\s*<td>\s*<div class="PriceTag">\s*(\d+)\s*<\/div>\s*<\/td>/g;

function extractPoints(html) {
  const out = [];
  let m;
  COST_PAIR_RE.lastIndex = 0;
  while ((m = COST_PAIR_RE.exec(html))) {
    out.push(`${m[2]} pts (${m[1]} model${m[1] === '1' ? '' : 's'})`);
  }
  // Some units repeat an identical-priced tier more than once (e.g. several
  // wargear-loadout blocks that all cost the same) — deduped rather than
  // shown as a misleadingly repeated option.
  return [...new Set(out)].join(' / ');
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main() {
  const [datasheets, factions] = await Promise.all([
    fetchCsv('Datasheets.csv'),
    fetchCsv('Factions.csv'),
  ]);
  const factionById = new Map(factions.map((f) => [f.id, f.name]));

  // Warhammer Legends (retired) datasheets aren't part of current-edition
  // play and have no current points cost to show — excluded here the same
  // way fetch-datasheets.mjs already excludes them.
  const real = datasheets.filter((d) => d.name && d.link && d.faction_id && d.legend?.toLowerCase() !== 'true');
  console.log('Datasheets to fetch points for:', real.length, 'of', datasheets.length);

  let fetched = 0;
  let withPoints = 0;
  const units = {};

  await mapWithConcurrency(real, CONCURRENCY, async (d) => {
    let html;
    try {
      const res = await fetch(d.link, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; warcamera-4k-points-bot/1.0)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = await res.text();
    } catch (err) {
      console.error(`Failed to fetch ${d.link}: ${err.message}`);
      return;
    }
    fetched++;
    const points = extractPoints(html);
    if (!points) return; // e.g. a support/wargear-only datasheet with no cost of its own
    withPoints++;
    const key = normalizeName(d.name);
    if (!key) return;
    units[key] = {
      displayName: d.name,
      points,
      faction: factionById.get(d.faction_id) || '',
    };
  });

  const count = Object.keys(units).length;
  console.log('Pages fetched:', fetched, '/ with a points table:', withPoints, '/ unique unit entries:', count);
  if (count < 500) {
    console.error(`Suspiciously few units with points (${count}) — extraction likely needs tuning.`);
  }

  const out = {
    version: 'wh40k11ed',
    sourceUrl: `${BASE}/the-rules/data-export/`,
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
