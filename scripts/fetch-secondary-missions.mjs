#!/usr/bin/env node
// Fetches the official Warhammer 40,000 11th-edition Tactical Secondary
// Mission deck from Wahapedia's Mission Deck 2026-27 rules page and writes
// a static public/secondary-missions-data.json the app draws cards from.
//
// Same page as fetch-missions.mjs (Primary Missions) — no CSV export exists
// for this either — but a different section ("Secondary Mission deck",
// between the "Primary Mission deck" and "Twist deck" anchors) and a
// different per-card shape:
//   - No ca7Fd trailer (Secondary Missions aren't looked up by disposition).
//   - An optional caPmIntro block, either a "WHEN DRAWN:" conditional
//     player choice (e.g. discard-and-redraw if a condition holds) or just
//     explanatory rules text with no special trigger — kept as free text
//     either way; nothing here needs the app to act on it automatically.
//   - Scoring lines can show ONE VP value (same as Primary Missions) OR a
//     FIXED/TACTICAL pair (caPmVPPair, two caPmVPCol spans) when the card
//     scores differently depending on which mode it's used in. This app
//     only implements the Tactical draw-two-per-turn flow (see
//     scripts/fetch-missions.mjs's sibling feature for the Primary Mission
//     side), so `vp` always holds the Tactical value; `fixedVp` is kept
//     alongside for completeness but unused by the app today.
//   - A scoring line can also open with an "OR" marker (caPmOr), same
//     placement/meaning as Primary Missions' leading "+" (caPmPlus) marker.
//
// The two real, sourced mechanics for cycling a Tactical Secondary Mission
// mid-battle (confirmed via the Core Rules' "Achieving Secondary Missions"
// step and the New Orders Core Stratagem row in Stratagems.csv — the same
// Stratagems.csv fetch-detachments.mjs already reads, just a universal row
// with a blank faction_id/detachment_id rather than a detachment-specific
// one) are NOT part of this page's per-card data — they're fixed app
// behaviour, wired directly into src/main.js instead of sourced here.
//
// Run by .github/workflows/update-secondary-missions.yml on the same
// weekly+manual-dispatch pattern as the other data pipelines.
import { writeFile } from 'node:fs/promises';

const PAGE_URL = 'https://wahapedia.ru/wh40k11ed/the-rules/mission-deck-2026-27/';

function stripHtml(s) {
  return (s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#8217;|&rsquo;/g, '’')
    .replace(/&#8216;|&lsquo;/g, '‘')
    .replace(/&#8220;|&ldquo;/g, '“')
    .replace(/&#8221;|&rdquo;/g, '”')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// A caPmScore's VP portion is either a single caPmVP (optionally followed
// by caPmCumul label(s) — "CUMULATIVE" or a "(UP TO NVP)" cap), or a
// caPmVPPair of two caPmVPCol columns labelled FIXED and TACTICAL (each
// possibly also carrying its own cap). Same leaf shape either way — pull
// every caPmVP plus the caPmCumul label(s) immediately following it, then
// decide which shape it is from how many caPmVP matches turned up.
function parseVp(rawScoreHtml) {
  const vpRe = /<span class="caPmVP">([^<]+)<\/span>((?:<span class="caPmCumul">[^<]*<\/span>)*)/g;
  const found = [];
  let m;
  while ((m = vpRe.exec(rawScoreHtml))) {
    const labels = [...m[2].matchAll(/<span class="caPmCumul">([^<]*)<\/span>/g)].map((x) => x[1].trim());
    found.push({ vp: m[1].trim(), labels });
  }
  const capOf = (labels) => labels.find((l) => l.startsWith('(')) || '';
  if (found.length === 2) {
    const fixed = found.find((f) => f.labels.includes('FIXED')) || found[0];
    const tactical = found.find((f) => f.labels.includes('TACTICAL')) || found[1];
    return { vp: tactical.vp, fixedVp: fixed.vp, cumulative: false, cap: capOf(tactical.labels) || capOf(fixed.labels) };
  }
  if (found.length === 1) {
    return { vp: found[0].vp, fixedVp: '', cumulative: found[0].labels.includes('CUMULATIVE'), cap: capOf(found[0].labels) };
  }
  return { vp: '', fixedVp: '', cumulative: false, cap: '' };
}

const LEAF_RE = /<div class="caPmIntro">([\s\S]*?)<\/div>(?=<div class="ca(?:PmBlock|Act)")|<div class="caPmHdr">([^<]*)<\/div>|<div class="caPmWhen"><b>WHEN:<\/b>([\s\S]*?)<\/div>|<div class="caPmScore">([\s\S]*?)<\/div>|<div class="caActHdr">([\s\S]*?)<span class="caActIco">|<div class="caActRow"><span class="caActLbl">([^<]+)<\/span>([\s\S]*?)<\/div>/g;

function parseCard(cardHtml) {
  const nameMatch = cardHtml.match(/<div class="ca7Name">([^<]*)<\/div>/);
  const typeMatch = cardHtml.match(/<span class="ca7TypeSolo">([^<]*)<\/span>/);
  if (!nameMatch || !typeMatch) return null;

  const isFixedEligible = /<div class="ca7Fixed/.test(cardHtml);
  const flavorMatch = cardHtml.match(/<p class="ShowFluff ca7Legend">([\s\S]*?)<\/p>/);
  const bodyStart = cardHtml.indexOf('class="ca7Body">');
  if (bodyStart === -1) return null;
  // Secondary Mission cards have no ca7Fd trailer (unlike Primary Missions)
  // — the body just runs to the end of this already-isolated per-card chunk.
  const body = cardHtml.slice(bodyStart + 'class="ca7Body">'.length);

  let intro = '';
  const scoring = [];
  let action = null;
  let currentBlock = null;
  let m;
  LEAF_RE.lastIndex = 0;
  while ((m = LEAF_RE.exec(body))) {
    if (m[1] !== undefined) {
      intro = stripHtml(m[1]).replace(/^WHEN DRAWN:\s*/, '');
    } else if (m[2] !== undefined) {
      currentBlock = { header: stripHtml(m[2]), when: '', entries: [] };
      scoring.push(currentBlock);
    } else if (m[3] !== undefined) {
      if (currentBlock) currentBlock.when = stripHtml(m[3]).replace(/^:\s*/, '');
    } else if (m[4] !== undefined) {
      const raw = m[4];
      const or = /^<span class="caPmOr">/.test(raw);
      const plus = /^<span class="caPmPlus">/.test(raw);
      const { vp, fixedVp, cumulative, cap } = parseVp(raw);
      const desc = raw
        .replace(/<span class="caPmOr">[\s\S]*?<\/span>/, '')
        .replace(/<span class="caPmPlus">[\s\S]*?<\/span>/, '')
        .replace(/<span class="caPmVPPair">[\s\S]*?<\/span><\/span><\/span>/, '')
        .replace(/<span class="caPmVPCol">[\s\S]*?<\/span>\s*$/, '')
        .replace(/<span class="caPmVP">[^<]*<\/span>\s*$/, '');
      if (currentBlock) {
        currentBlock.entries.push({ text: stripHtml(desc), vp, fixedVp, plus, or, cumulative, cap });
      }
    } else if (m[5] !== undefined) {
      action = { displayName: stripHtml(m[5]), rows: [] };
    } else if (m[6] !== undefined) {
      if (action) action.rows.push({ label: stripHtml(m[6]).replace(/:$/, ''), text: stripHtml(m[7]) });
    }
  }

  return {
    displayName: stripHtml(nameMatch[1]),
    flavor: flavorMatch ? stripHtml(flavorMatch[1]) : '',
    intro,
    isFixedEligible,
    scoring,
    action,
  };
}

async function main() {
  const res = await fetch(PAGE_URL, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; warcamera-4k-secondary-missions-bot/1.0)' } });
  if (!res.ok) throw new Error(`Failed to fetch ${PAGE_URL}: ${res.status}`);
  const html = await res.text();

  const smIdx = html.indexOf('id="Secondary-Mission-deck"');
  const twIdx = html.indexOf('id="Twist-deck"');
  if (smIdx === -1 || twIdx === -1 || twIdx <= smIdx) {
    throw new Error('Could not locate the Secondary Mission deck section on the page — its layout may have changed.');
  }
  const section = html.slice(smIdx, twIdx);
  const cards = section.split('<div class="cgCard_pad">').slice(1);

  const missions = [];
  for (const cardHtml of cards) {
    const mission = parseCard(cardHtml);
    if (mission) missions.push(mission);
  }

  console.log('Secondary Missions parsed:', missions.length, '(expect 18)');
  if (missions.length < 15) {
    console.error(`Suspiciously few Secondary Missions (${missions.length}) — page layout likely changed; check the parser.`);
  }

  const out = {
    version: 'wh40k11ed-mission-deck-2026-27',
    sourceUrl: PAGE_URL,
    updatedAt: new Date().toISOString(),
    missionCount: missions.length,
    missions,
  };

  await writeFile(new URL('../public/secondary-missions-data.json', import.meta.url), JSON.stringify(out) + '\n');
  console.log('Wrote public/secondary-missions-data.json');
}

main().catch((err) => {
  console.error('fetch-secondary-missions failed:', err.message);
  process.exit(1);
});
