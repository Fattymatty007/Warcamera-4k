#!/usr/bin/env node
// Fetches the current official Warhammer 40,000 Munitorum Field Manual PDF
// from Warhammer Community and extracts unit-name -> points-cost pairs into
// public/points-data.json. The app fetches that file directly (same origin,
// no worker/Gemini call involved) and prefers it over the model's own guess
// whenever a unit matches, since GW's own published points are authoritative
// and the model's training data inevitably lags balance updates.
//
// Run by .github/workflows/update-points.yml on a schedule and via manual
// dispatch. The PDF's exact table layout could only be inspected by actually
// running this in CI — warhammer-community.com is unreachable from some dev
// sandboxes — so the extraction heuristic below (extractUnits) is a
// best-effort first pass; the verbose logging exists so a failed or
// low-confidence run is diagnosable straight from the Action's log output
// without needing to reproduce it locally.
import { writeFile } from 'node:fs/promises';

const LANDING_URL = 'https://mfm.warhammer-community.com/en';

async function findPdfUrl() {
  const res = await fetch(LANDING_URL, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; warcamera-4k-points-bot/1.0)' } });
  if (!res.ok) throw new Error(`Landing page fetch failed: ${res.status}`);
  const html = await res.text();

  // The page is a client-rendered Next.js app, so a PDF link isn't
  // necessarily a plain <a href> in the raw HTML fetched here — it may be
  // embedded as an escaped URL string inside inline script/data payloads
  // (e.g. Next.js flight data), possibly on a different asset domain than
  // assumed. Search the whole document for any *.pdf URL rather than one
  // fixed pattern, so this survives that kind of embedding.
  const urlRe = /https?:\\?\/\\?\/[^"'\s)\\]+?\.pdf/gi;
  const rawMatches = [...html.matchAll(urlRe)].map(m => m[0].replace(/\\\//g, '/'));
  const matches = [...new Set(rawMatches)];

  if (matches.length === 0) {
    console.error('--- no .pdf URL found anywhere in the landing page. Contexts around every ".pdf" substring: ---');
    let idx = html.toLowerCase().indexOf('.pdf');
    let hits = 0;
    while (idx !== -1 && hits < 10) {
      console.error(html.slice(Math.max(0, idx - 200), idx + 20));
      console.error('---');
      idx = html.toLowerCase().indexOf('.pdf', idx + 1);
      hits++;
    }
    if (hits === 0) {
      console.error('(the substring ".pdf" does not appear in the fetched HTML at all — the PDF link is likely loaded via a separate API call this script does not know about yet)');
      console.error('--- landing page HTML (first 4000 chars) ---');
      console.error(html.slice(0, 4000));
    }
    throw new Error('Could not find a .pdf link on the MFM landing page — see contexts above to identify the real pattern/domain.');
  }

  console.log('Candidate PDF URLs found:', matches);
  // Prefer one that looks like the actual field manual rather than an
  // unrelated PDF elsewhere on the page.
  const best = matches.find(u => /munitorum|field.?manual/i.test(u)) || matches[0];
  return best;
}

function normalizeName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Best-effort line-based extraction: a unit entry typically ends in one or
// more numeric points values (optionally followed by "pts"/"points"), e.g.
// "Intercessor Squad 80" or "Terminator Squad 190". Everything before the
// first such trailing number run is taken as the unit name.
function extractUnits(text) {
  const units = {};
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const lineRe = /^(.{2,80}?)\s+((?:\d{1,4}\s*(?:pts?\.?|points?)?\s*)+)$/i;
  for (const line of lines) {
    const m = line.match(lineRe);
    if (!m) continue;
    const rawName = m[1].trim();
    const pointsText = m[2].trim();
    if (!/[a-zA-Z]/.test(rawName) || rawName.length < 2) continue;
    const key = normalizeName(rawName);
    if (!key) continue;
    units[key] = { displayName: rawName, points: pointsText };
  }
  return units;
}

async function main() {
  const pdfUrl = await findPdfUrl();
  console.log('Found PDF URL:', pdfUrl);

  const pdfRes = await fetch(pdfUrl);
  if (!pdfRes.ok) throw new Error(`PDF fetch failed: ${pdfRes.status}`);
  const buf = Buffer.from(await pdfRes.arrayBuffer());
  console.log('Downloaded PDF, bytes:', buf.length);

  const pdfParse = (await import('pdf-parse')).default;
  const data = await pdfParse(buf);
  console.log('Extracted text length:', data.text.length, 'pages:', data.numpages);
  console.log('--- text sample (first 2000 chars) ---');
  console.log(data.text.slice(0, 2000));

  const units = extractUnits(data.text);
  const count = Object.keys(units).length;
  console.log('Extracted unit entries:', count);
  if (count < 20) {
    console.error('Suspiciously few units extracted (' + count + ') — parsing heuristic likely needs tuning against the text sample above.');
  }

  const versionMatch = data.text.match(/version\s*(\d+(\.\d+)?)/i);

  const out = {
    version: versionMatch ? versionMatch[1] : null,
    sourceUrl: pdfUrl,
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
