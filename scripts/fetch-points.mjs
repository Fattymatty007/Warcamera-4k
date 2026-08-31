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
import { chromium } from 'playwright';

const LANDING_URL = 'https://mfm.warhammer-community.com/en';

// A plain fetch() of the landing page's HTML contains no ".pdf" substring
// anywhere — confirmed against the real site via this script's own CI run,
// since it's a fully client-rendered Next.js app that loads its download
// link after hydration (not embedded in the initial payload at all, not
// even in inline script data). A headless browser is the only reliable way
// to see what a real visitor sees, so drive one instead of scraping raw HTML.
async function findPdfUrl() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const seenPdfResponses = [];
    page.on('response', (res) => {
      if (/\.pdf(\?|$)/i.test(res.url())) seenPdfResponses.push(res.url());
    });

    await page.goto(LANDING_URL, { waitUntil: 'networkidle', timeout: 60000 });

    // Strategy 1: a PDF response was fetched during load (e.g. prefetched,
    // or opened in an embedded viewer).
    if (seenPdfResponses.length > 0) {
      console.log('PDF seen via network response:', seenPdfResponses);
      return seenPdfResponses[0];
    }

    // Strategy 2: a rendered <a href> pointing at a PDF.
    const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.href));
    const pdfHrefs = hrefs.filter((h) => /\.pdf(\?|$)/i.test(h));
    if (pdfHrefs.length > 0) {
      console.log('PDF link(s) found in rendered DOM:', pdfHrefs);
      const best = pdfHrefs.find((u) => /munitorum|field.?manual/i.test(u)) || pdfHrefs[0];
      return best;
    }

    // Nothing found — dump enough of the rendered page to diagnose from CI
    // logs directly (this domain is unreachable from some dev sandboxes).
    console.error('No PDF found via network responses or rendered <a href>. All links on the page:');
    console.error(JSON.stringify(hrefs, null, 2));
    const bodyText = await page.evaluate(() => document.body.innerText);
    console.error('--- rendered page text (first 3000 chars) ---');
    console.error(bodyText.slice(0, 3000));
    throw new Error('Could not find the Field Manual PDF link on the rendered landing page — see the link/text dump above.');
  } finally {
    await browser.close();
  }
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
