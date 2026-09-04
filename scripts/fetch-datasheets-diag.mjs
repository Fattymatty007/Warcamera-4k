#!/usr/bin/env node
// DIAGNOSTIC ONLY — not the real fetch script. Wahapedia.ru is unreachable
// from this dev sandbox, so this probes the real site's actual page/export
// structure from CI (which has normal internet access) and dumps enough
// raw output to design the real parser against real data instead of
// guesswork. Same two-phase approach used to build fetch-points.mjs.
const BASE = 'https://wahapedia.ru/wh40k11ed';
const EXPORT_PAGE = `${BASE}/the-rules/data-export/`;

async function main() {
  console.log('Fetching export page:', EXPORT_PAGE);
  const res = await fetch(EXPORT_PAGE, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; warcamera-4k-datasheets-bot/1.0)' } });
  console.log('status:', res.status);
  const html = await res.text();
  console.log('html length:', html.length);

  const csvLinks = [...new Set([...html.matchAll(/https?:\/\/[^"'\s)]+?\.csv/gi)].map(m => m[0]))];
  const relativeCsvLinks = [...new Set([...html.matchAll(/href=["']([^"']+?\.csv)["']/gi)].map(m => m[1]))];
  console.log('absolute .csv links found:', JSON.stringify(csvLinks, null, 2));
  console.log('relative .csv links found:', JSON.stringify(relativeCsvLinks, null, 2));

  if (csvLinks.length === 0 && relativeCsvLinks.length === 0) {
    console.log('--- no CSV links found in raw HTML; first 4000 chars of page ---');
    console.log(html.slice(0, 4000));
  }

  // Try well-known Wahapedia export filenames directly, in case the page
  // itself doesn't link them plainly (e.g. JS-rendered list, or a zip).
  const guesses = [
    'Datasheets.csv', 'Datasheets_abilities.csv', 'Datasheets_keywords.csv',
    'Datasheets_models.csv', 'Datasheets_options.csv', 'Datasheets_wargear.csv',
    'Datasheets_unit_composition.csv', 'Datasheets_leader.csv',
    'Datasheets_stratagems.csv', 'Datasheets_enhancements.csv',
    'Abilities.csv', 'Factions.csv', 'Source.csv', 'Last_update.csv',
  ];
  const candidateBases = [`${BASE}/Export/`, `${BASE}/export/`, `${BASE}/`];
  const found = [];
  for (const base of candidateBases) {
    for (const name of guesses) {
      const url = base + name;
      try {
        const r = await fetch(url, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (r.ok) {
          const text = await r.text();
          found.push({ url, status: r.status, bytes: text.length, sample: text.slice(0, 300) });
          console.log('FOUND:', url, '| bytes:', text.length);
        } else {
          console.log('miss:', url, '| status:', r.status);
        }
      } catch (e) {
        console.log('error fetching', url, ':', e.message);
      }
    }
  }

  console.log('=== SUMMARY: found', found.length, 'CSV files ===');
  for (const f of found) {
    console.log('---', f.url, '---');
    console.log(f.sample);
  }
}

main().catch((err) => {
  console.error('diagnostic failed:', err.message);
  process.exit(1);
});
