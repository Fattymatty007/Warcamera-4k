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

// Real page structure (confirmed against actual rendered text from CI —
// this domain is unreachable from some dev sandboxes, so it could only be
// inspected by running this in CI): each unit is a block, not a single
// line —
//   UNIT NAME
//   YOUR UNIT COSTS            (or "YOUR 1ST TO 2ND UNITS COST", etc. —
//   3 models                    a unit can have several of these tiers,
//   50 pts                      each followed by one or more model-count/
//   10 models                   points pairs)
//   140 pts
//   LEADER                     (optional attachment info, ignored)
//   BATTLE SISTERS SQUAD, ...
// The unit name is reliably the line immediately before its first
// "YOUR ... COST(S)" header; wargear-option lines ("per Meltagun" / "5 pts")
// never appear directly before such a header, so they're never mistaken
// for a unit's own cost pair by the model-count/points pairing below.
function extractUnitsFromText(text) {
  const units = {};
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const costHeaderRe = /^YOUR\b.*\bCOSTS?$/i;
  const modelsRe = /^(\d+)\s+models?$/i;
  const ptsRe = /^(\d+)\s*pts?\.?$/i;

  let i = 0;
  while (i < lines.length) {
    if (!costHeaderRe.test(lines[i])) {
      i++;
      continue;
    }
    const rawName = i > 0 ? lines[i - 1] : null;
    i++; // past the header
    const sizeCosts = [];
    while (i < lines.length) {
      const modelsMatch = lines[i].match(modelsRe);
      if (modelsMatch && lines[i + 1] && ptsRe.test(lines[i + 1])) {
        const modelsCount = modelsMatch[1];
        const pts = lines[i + 1].match(ptsRe)[1];
        sizeCosts.push(`${pts} pts (${modelsCount} model${modelsCount === '1' ? '' : 's'})`);
        i += 2;
      } else if (costHeaderRe.test(lines[i])) {
        i++; // another tier of the same unit — keep collecting pairs
      } else {
        break;
      }
    }
    if (rawName && sizeCosts.length > 0 && !costHeaderRe.test(rawName)) {
      const key = normalizeName(rawName);
      if (key) units[key] = { displayName: rawName, points: sizeCosts.join(' / ') };
    }
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
