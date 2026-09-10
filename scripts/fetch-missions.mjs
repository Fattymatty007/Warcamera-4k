#!/usr/bin/env node
// Fetches the official Warhammer 40,000 11th-edition "Force Disposition"
// Primary Mission system from Wahapedia's Mission Deck 2026-27 rules page
// and writes a static public/missions-data.json the app reads directly.
//
// Unlike Detachments/Datasheets/points, this data has no pipe-delimited CSV
// export — it lives only as server-rendered HTML on the rules page itself
// (confirmed via a CI diagnostic dispatch: every Missions*.csv/Deployment*
// .csv name tried came back 404). So this script scrapes that page's HTML
// directly instead of hitting the /wh40k11ed/*.csv base fetch-detachments.mjs
// and fetch-datasheets.mjs use.
//
// The rule (from the page itself): each player secretly picks one of their
// available Force Disposition cards, both reveal, then each player looks up
// their OWN Primary Mission on their OWN card using their OPPONENT's
// disposition as the lookup key — so the two players' missions are usually
// different from each other, even though there are only 5 dispositions and
// 25 (5x5) total mission slots. The 25 (player, opponent) pairs and their
// resulting mission names were verified directly against the page's HTML
// (each mission's own card embeds a `ca7Fd` block naming exactly which
// player/opponent disposition pair it belongs to — no need to reconstruct
// this from the separate "Force Disposition Cards" grid section at all)
// and cross-checked against two independent examples from public mission
// guides (Purge the Foe vs Take and Hold -> Unstoppable Force; Take and
// Hold vs Purge the Foe -> Immovable Object) — both matched exactly.
//
// A mission's scoring conditions are grouped into "blocks", each covering
// some subset of the 5 battle rounds (e.g. "ANY BATTLE ROUND", "SECOND
// BATTLE ROUND ONWARDS", "FIFTH BATTLE ROUND", "END OF THE BATTLE"). Some
// missions also reference a specific "Objective Action" (e.g. Booby Trap,
// Decoy, Sensor Sweep) that a unit performs to set up later scoring — these
// are embedded inside their own mission's card in the source, not shared
// across missions, so they're kept as a single optional `action` field per
// mission rather than a separate lookup table.
//
// Run by .github/workflows/update-missions.yml on a schedule and via manual
// dispatch — mirrors update-detachments.yml (self-triggers the Pages deploy
// after committing, since a push using the default GITHUB_TOKEN doesn't
// trigger other workflows on its own).
import { writeFile } from 'node:fs/promises';

const PAGE_URL = 'https://wahapedia.ru/wh40k11ed/the-rules/mission-deck-2026-27/';

// Maps the source's icon CSS class (e.g. "PurgeTheFoe2") to the disposition's
// display name, exactly as fetch-detachments.mjs already sources it from
// Detachments.csv's force_disposition column — same 5 names, same spelling.
const DISPOSITION_BY_CLASS = {
  PurgeTheFoe2: 'Purge the Foe',
  TakeAndHold2: 'Take and Hold',
  Reconnaissance2: 'Reconnaissance',
  PriorityAssets2: 'Priority Assets',
  Disruption2: 'Disruption',
};

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

function normalizeName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function dispositionKey(displayName) {
  return normalizeName(displayName).replace(/\s+/g, '');
}

// Each caPmScore line is a single, non-nested <div> (only <span>s inside),
// so a non-greedy match safely stops at its own closing tag — same for
// caPmHdr/caPmWhen/caActRow below. Scanning the whole card body with one
// combined alternation, in document order, means the exact (unlabelled)
// closing tags of the caPmBlock/caAct wrapper divs never need to be
// matched at all.
const LEAF_RE = /<div class="caPmHdr">([^<]*)<\/div>|<div class="caPmWhen"><b>WHEN:<\/b>([\s\S]*?)<\/div>|<div class="caPmScore">([\s\S]*?)<\/div>|<div class="caActHdr">([\s\S]*?)<span class="caActIco">|<div class="caActRow"><span class="caActLbl">([^<]+)<\/span>([\s\S]*?)<\/div>/g;

function parseCard(cardHtml) {
  const nameMatch = cardHtml.match(/<div class="ca7Name">([^<]*)<\/div>/);
  const typeMatch = cardHtml.match(/<div class="ca7Type">([^<]*)<\/div>/);
  if (!nameMatch || !typeMatch || typeMatch[1].trim() !== 'Primary Mission') return null;

  const flavorMatch = cardHtml.match(/<p class="ShowFluff ca7Legend">([\s\S]*?)<\/p>/);
  const bodyStart = cardHtml.indexOf('class="ca7Body">');
  const fdStart = cardHtml.indexOf('<div class="ca7Fd">');
  if (bodyStart === -1 || fdStart === -1) return null;
  const body = cardHtml.slice(bodyStart + 'class="ca7Body">'.length, fdStart);

  const scoring = [];
  let action = null;
  let currentBlock = null;
  let m;
  LEAF_RE.lastIndex = 0;
  while ((m = LEAF_RE.exec(body))) {
    if (m[1] !== undefined) {
      // caPmHdr — starts a new scoring block.
      currentBlock = { header: stripHtml(m[1]), when: '', entries: [] };
      scoring.push(currentBlock);
    } else if (m[2] !== undefined) {
      // caPmWhen — belongs to the block just opened.
      if (currentBlock) currentBlock.when = stripHtml(m[2]).replace(/^:\s*/, '');
    } else if (m[3] !== undefined) {
      // caPmScore — one scoring entry within the current block.
      const raw = m[3];
      const plus = /^<span class="caPmPlus">/.test(raw);
      const vpMatch = raw.match(/class="caPmVP">([^<]+)</);
      const cumulative = /class="caPmCumul"/.test(raw);
      // The description is everything except the leading plus marker and
      // the trailing VP span(s) — strip those spans out, then strip tags.
      const desc = raw
        .replace(/<span class="caPmPlus">[\s\S]*?<\/span>/, '')
        .replace(/<span class="caPmVPCol">[\s\S]*?<\/span>\s*$/, '')
        .replace(/<span class="caPmVP">[^<]*<\/span>\s*$/, '');
      if (currentBlock) {
        currentBlock.entries.push({
          text: stripHtml(desc),
          vp: vpMatch ? vpMatch[1].trim() : '',
          plus,
          cumulative,
        });
      }
    } else if (m[4] !== undefined) {
      // caActHdr — starts this mission's (optional) Objective Action.
      action = { displayName: stripHtml(m[4]), rows: [] };
    } else if (m[5] !== undefined) {
      // caActRow — one labelled field of the current action.
      if (action) action.rows.push({ label: stripHtml(m[5]).replace(/:$/, ''), text: stripHtml(m[6]) });
    }
  }

  const fdBlock = cardHtml.slice(fdStart);
  const playerClassMatch = fdBlock.match(/class="ca7FdPlayer"><div class="([A-Za-z]+2)">/);
  const oppClassMatch = fdBlock.match(/class="ca7FdOpp"><div class="ca7FdLbl">Opponent<\/div><div class="([A-Za-z]+2)">/);
  const playerDisposition = playerClassMatch ? DISPOSITION_BY_CLASS[playerClassMatch[1]] : null;
  const opponentDisposition = oppClassMatch ? DISPOSITION_BY_CLASS[oppClassMatch[1]] : null;
  if (!playerDisposition || !opponentDisposition) return null;

  return {
    displayName: stripHtml(nameMatch[1]),
    playerDisposition,
    opponentDisposition,
    flavor: flavorMatch ? stripHtml(flavorMatch[1]) : '',
    scoring,
    action,
  };
}

async function main() {
  const res = await fetch(PAGE_URL, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; warcamera-4k-missions-bot/1.0)' } });
  if (!res.ok) throw new Error(`Failed to fetch ${PAGE_URL}: ${res.status}`);
  const html = await res.text();

  const pmIdx = html.indexOf('id="Primary-Mission-deck"');
  const depIdx = html.indexOf('id="Deployment-deck"');
  if (pmIdx === -1 || depIdx === -1 || depIdx <= pmIdx) {
    throw new Error('Could not locate the Primary Mission deck section on the page — its layout may have changed.');
  }
  const section = html.slice(pmIdx, depIdx);
  const cards = section.split('<div class="cgCard_pad">').slice(1);

  const missions = [];
  for (const cardHtml of cards) {
    const mission = parseCard(cardHtml);
    if (mission) missions.push(mission);
  }

  console.log('Primary Missions parsed:', missions.length, '(expect 25 — 5 dispositions x 5 opponent dispositions)');
  if (missions.length !== 25) {
    console.error(`Unexpected mission count (${missions.length}, expected 25) — page layout likely changed; check the parser.`);
  }

  const byKey = {};
  for (const mission of missions) {
    const key = `${dispositionKey(mission.playerDisposition)}|${dispositionKey(mission.opponentDisposition)}`;
    if (byKey[key]) {
      console.error(`Duplicate (player, opponent) pair for key ${key}: ${byKey[key]} and ${mission.displayName}`);
    }
    byKey[key] = mission.displayName;
  }

  const out = {
    version: 'wh40k11ed-mission-deck-2026-27',
    sourceUrl: PAGE_URL,
    updatedAt: new Date().toISOString(),
    dispositions: Object.values(DISPOSITION_BY_CLASS),
    missions,
  };

  await writeFile(new URL('../public/missions-data.json', import.meta.url), JSON.stringify(out) + '\n');
  console.log('Wrote public/missions-data.json');
}

main().catch((err) => {
  console.error('fetch-missions failed:', err.message);
  process.exit(1);
});
