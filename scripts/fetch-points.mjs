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
  const match = html.match(/https:\/\/assets\.warhammer-community\.com\/[^"'\s)]+\.pdf/i);
  if (!match) {
    console.error('--- landing page HTML (first 3000 chars) ---');
    console.error(html.slice(0, 3000));
    throw new Error('Could not find a .pdf link on the MFM landing page — its structure may have changed. See HTML dump above.');
  }
  return match[0];
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
