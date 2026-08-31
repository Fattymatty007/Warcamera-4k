#!/usr/bin/env node
// Fetches current official Warhammer 40,000 points from Games Workshop's own
// Munitorum Field Manual web app (mfm.warhammer-community.com) and extracts
// unit-name -> points-cost pairs into public/points-data.json. The app
// fetches that file directly (same origin, no worker/Gemini call involved)
// and prefers it over the model's own guess whenever a unit matches, since
// GW's own published points are authoritative and the model's training data
// inevitably lags balance updates.
//
// Run by .github/workflows/update-points.yml on a schedule and via manual
// dispatch. Two earlier real CI runs (this domain is unreachable from some
// dev sandboxes, so it can only be inspected by actually running this in
// CI) established: the landing page is a fully client-rendered Next.js app
// with no usable link in its raw HTML at all — a headless browser is
// required — and it isn't a single downloadable PDF, but a hub linking to
// one rendered page per faction (e.g. /en/space-marines) that lists that
// faction's units and points directly. The extraction heuristic below is a
// best-effort first pass against real faction-page text; the verbose
// logging exists so a low-confidence run is diagnosable from the Action's
// log output without needing to reproduce it locally.
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const LANDING_URL = 'https://mfm.warhammer-community.com/en';

function normalizeName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// A unit line typically ends in one or more numeric points values
// (optionally followed by "pts"/"points"), e.g. "Intercessor Squad 80" or
// "Terminator Squad 190". Everything before the first such trailing number
// run is taken as the unit name.
function extractUnitsFromText(text) {
  const units = {};
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
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
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(LANDING_URL, { waitUntil: 'networkidle', timeout: 60000 });

    const bodyText = await page.evaluate(() => document.body.innerText);
    const versionMatch = bodyText.match(/\bv(\d+(\.\d+)?)\b/i);
    const version = versionMatch ? versionMatch[1] : null;
    console.log('Detected MFM version string:', version);

    // Anchor `href` attributes on this page are relative (e.g. "/en/space-marines"),
    // so a CSS attribute-prefix selector against the absolute URL matches nothing —
    // confirmed by the run right before this fix, which found 0 links this way even
    // though the DOM's resolved `.href` property (used below) had them all along.
    const factionLinks = await page.$$eval('a[href]', (as) =>
      [...new Set(as.map((a) => a.href))].filter(
        (h) => h.startsWith('https://mfm.warhammer-community.com/en/') && !/\/en\/?$/.test(h),
      ),
    );
    console.log('Faction pages found:', factionLinks.length);
    console.log(factionLinks);

    if (factionLinks.length === 0) {
      throw new Error('No faction sub-pages found on the landing page — its structure may have changed.');
    }

    const allUnits = {};
    let firstPageDumped = false;

    for (const url of factionLinks) {
      const factionPage = await browser.newPage();
      try {
        await factionPage.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
        const text = await factionPage.evaluate(() => document.body.innerText);

        if (!firstPageDumped) {
          console.log(`--- rendered text sample from ${url} (first 3000 chars) ---`);
          console.log(text.slice(0, 3000));
          firstPageDumped = true;
        }

        const units = extractUnitsFromText(text);
        const factionSlug = url.split('/').filter(Boolean).pop();
        for (const [key, val] of Object.entries(units)) {
          allUnits[key] = { ...val, faction: factionSlug };
        }
        console.log(`${url}: extracted ${Object.keys(units).length} units`);
      } catch (err) {
        console.error(`Failed on ${url}:`, err.message);
      } finally {
        await factionPage.close();
      }
    }

    const count = Object.keys(allUnits).length;
    console.log('Total extracted unit entries:', count);
    if (count < 50) {
      console.error(`Suspiciously few units extracted overall (${count}) — heuristic likely needs tuning against the text sample above.`);
    }

    const out = {
      version,
      sourceUrl: LANDING_URL,
      updatedAt: new Date().toISOString(),
      unitCount: count,
      units: allUnits,
    };

    await writeFile(new URL('../public/points-data.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
    console.log('Wrote public/points-data.json');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('fetch-points failed:', err.message);
  process.exit(1);
});
