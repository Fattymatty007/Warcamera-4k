import './style.css';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { callGemini } from './api.js';
import { loadCustomModels, saveCustomModelsList, loadUserApiKey, saveUserApiKey, loadBattles, saveBattlesList, loadCollection, saveCollectionList } from './storage.js';

// Date.now() alone isn't unique enough for ids assigned in a tight loop
// (e.g. importing several units from a folder into a battle back to back)
// — awaited storage calls can resolve within the same millisecond, so two
// entries can land on the same id. A trailing counter makes each call to
// uid() distinct even when Date.now() repeats.
let uidCounter = 0;
function uid(prefix){
  uidCounter += 1;
  return prefix + Date.now() + '_' + uidCounter;
}

// Fires onLongPress after a sustained press/hold on el, without also
// firing the element's normal click handler for that same press. Works
// for both touch and mouse so the desktop dev/preview flow behaves the
// same way. The card itself still gets a plain click's usual navigation —
// callers just need to check the flag this passes back before acting on
// their own click listener, since a long-press's release still fires one.
// A held press is exactly the gesture browsers use to start their own
// text-selection/callout UI, and that native behavior can win the moment
// onLongPress() swaps the screen out from under a still-active touch — the
// CSS on #app (see style.css) blocks selection on the elements themselves,
// and this blocks the 'selectstart' event too as belt-and-suspenders for
// whatever's on screen for the rest of this gesture, old content or new.
let longPressActive = false;
document.addEventListener('selectstart', (e) => {
  if(longPressActive) e.preventDefault();
});

function attachLongPress(el, onLongPress, duration = 550){
  let timer = null;
  let fired = false;
  const start = () => {
    fired = false;
    longPressActive = true;
    timer = setTimeout(() => { fired = true; onLongPress(); }, duration);
  };
  const cancel = () => {
    if(timer){ clearTimeout(timer); timer = null; }
    longPressActive = false;
  };
  el.addEventListener('touchstart', start, { passive: true });
  el.addEventListener('touchend', cancel);
  el.addEventListener('touchmove', cancel, { passive: true });
  el.addEventListener('touchcancel', cancel);
  el.addEventListener('mousedown', start);
  el.addEventListener('mouseup', cancel);
  el.addEventListener('mouseleave', cancel);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  return () => fired;
}

// Two model tiers, picked per call via the X-Gemini-Model header (see
// api.js / worker/src/index.js) rather than a fixed worker-side model.
// Vision identification stays on the stronger default model — it already
// had real accuracy issues telling visually similar miniatures apart, so
// it's not a good place to trade capability for speed. Datasheet lookups
// are plain text recall + JSON formatting, a much better fit for the
// faster/cheaper Flash-Lite tier. gemini-flash-lite-latest is a best-effort
// name — it follows the same "-latest" alias pattern already confirmed
// working for gemini-flash-latest, but wasn't independently verified
// against Google's docs (blocked from this environment) — if it 404s,
// the fix is the same one we already did once: pull the exact model ID
// from the cURL quickstart on the account's AI Studio API key page.
const VISION_MODEL = 'gemini-flash-latest';
const TEXT_MODEL = 'gemini-flash-lite-latest';

// Official points data, extracted from Games Workshop's own Munitorum Field
// Manual PDF by .github/workflows/update-points.yml (see scripts/fetch-points.mjs)
// and served as a static file alongside the app — no worker/Gemini call
// involved. Preferred over the model's own points guess whenever a unit
// matches, since GW's published points are authoritative and the model's
// training data inevitably lags balance updates.
let pointsDataPromise = null;
function loadPointsData(){
  if(!pointsDataPromise){
    pointsDataPromise = fetch('/points-data.json')
      .then(r => r.ok ? r.json() : null)
      .catch(() => null);
  }
  return pointsDataPromise;
}

function normalizePointsName(name){
  return (name||'').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Shared exact-then-substring key match used by both the points dataset and
// the datasheets dataset below (e.g. "Chaos Defiler" matching the source's
// plain "Defiler" entry).
function findDatasetKey(data, unitName){
  if(!data || !data.units) return null;
  const key = normalizePointsName(unitName);
  if(!key) return null;
  if(data.units[key]) return key;
  const keys = Object.keys(data.units);
  const hit = keys.find(k => k.length > 2 && (key.includes(k) || k.includes(key)));
  return hit || null;
}

function lookupInDataset(data, unitName){
  const key = findDatasetKey(data, unitName);
  return key ? data.units[key] : null;
}

async function lookupOfficialPoints(unitName){
  return lookupInDataset(await loadPointsData(), unitName);
}

function formatOfficialPoints(entry){
  const raw = (entry.points || '').trim();
  return /^\d+$/.test(raw) ? raw + ' pts' : raw;
}

// Official datasheets (stats/weapons/abilities/keywords), extracted from
// Wahapedia's public 11th-edition data export by
// .github/workflows/update-datasheets.yml (see scripts/fetch-datasheets.mjs)
// and served as a static file alongside the app — no worker/Gemini call
// involved. Checked BEFORE asking Gemini for a datasheet at all: when a
// unit matches, its stats/weapons/abilities come straight from this
// authoritative, current-edition-only source instead of the model's own
// knowledge, which blends every edition it's ever seen with no reliable
// way to tell current content apart from a retired weapon option — and
// which a visitor's own (usually unbilled, non-grounded) API key has no
// way to verify against anything current at all. Only a unit not found
// here (e.g. a very new release) falls through to asking Gemini.
let datasheetsDataPromise = null;
function loadDatasheetsData(){
  if(!datasheetsDataPromise){
    datasheetsDataPromise = fetch('/datasheets-data.json')
      .then(r => r.ok ? r.json() : null)
      .catch(() => null);
  }
  return datasheetsDataPromise;
}

// Detachment-level rules/enhancements/stratagems, extracted from Wahapedia's
// export by .github/workflows/update-detachments.yml (see
// scripts/fetch-detachments.mjs) — same static, zero-Gemini-call pattern as
// points and datasheets. Doesn't include faction-wide Army Rules; Wahapedia's
// export doesn't have that data at all (confirmed via CI dispatch).
let detachmentsDataPromise = null;
function loadDetachmentsData(){
  if(!detachmentsDataPromise){
    detachmentsDataPromise = fetch('/detachments-data.json')
      .then(r => r.ok ? r.json() : null)
      .catch(() => null);
  }
  return detachmentsDataPromise;
}

// A Detachment "card" saved into a collection folder or a battle roster is
// a frozen snapshot taken whenever it was added — disposition was added to
// that snapshot's shape after some users had already saved cards without
// it, so an old stored card can be missing disposition even though the
// live data (and a brand new lookup) has it. Patch it back in from the
// current detachments-data.json by faction+name whenever a saved card is
// about to be shown, instead of requiring the user to re-add it.
// The Force Disposition primary mission system: each Battle Round, each
// player's Primary Mission is looked up on their own Force Disposition card
// using their OPPONENT's disposition as the key — so the two sides usually
// have different missions, even between the same two players. Source is
// Wahapedia's Mission Deck 2026-27 page (see fetch-missions.mjs); this data
// has nothing to do with which Detachment a player brought beyond that
// Detachment's fixed disposition (see card.disposition, force_disposition
// in fetch-detachments.mjs) — it's the same 5-value lookup either way.
let missionsDataPromise = null;
function loadMissionsData(){
  if(!missionsDataPromise){
    missionsDataPromise = fetch('/missions-data.json')
      .then(r => r.ok ? r.json() : null)
      .catch(() => null);
  }
  return missionsDataPromise;
}

function findPrimaryMission(missionsData, playerDisposition, opponentDisposition){
  if(!missionsData || !playerDisposition || !opponentDisposition) return null;
  return missionsData.missions.find(m => m.playerDisposition === playerDisposition && m.opponentDisposition === opponentDisposition) || null;
}

// A mission's scoring is grouped into blocks, each headed by which Battle
// Round(s) it applies to (e.g. "ANY BATTLE ROUND", "SECOND BATTLE ROUND
// ONWARDS", "FIFTH BATTLE ROUND", "END OF THE BATTLE") — this turns that
// header text back into the actual round numbers it covers, so the block
// relevant to the tracker's current turn can be highlighted.
const BATTLE_ROUND_ORDINALS = { FIRST: 1, SECOND: 2, THIRD: 3, FOURTH: 4, FIFTH: 5 };
function roundsForMissionHeader(header, totalTurns){
  const h = (header || '').toUpperCase();
  if(h.includes('END OF THE BATTLE')) return [totalTurns];
  if(h.includes('ANY BATTLE ROUND')){
    const all = []; for(let i = 1; i <= totalTurns; i++) all.push(i); return all;
  }
  const words = h.replace(/BATTLE ROUNDS?/, '').trim().split(/\s+/).filter(Boolean);
  if(words.includes('ONWARDS')){
    const start = BATTLE_ROUND_ORDINALS[words[0]];
    if(!start) return [];
    const out = []; for(let i = start; i <= totalTurns; i++) out.push(i); return out;
  }
  if(words.includes('TO')){
    const start = BATTLE_ROUND_ORDINALS[words[0]];
    const end = BATTLE_ROUND_ORDINALS[words[words.indexOf('TO') + 1]];
    if(!start || !end) return [];
    const out = []; for(let i = start; i <= end; i++) out.push(i); return out;
  }
  if(words.includes('AND')){
    const nums = words.map(w => BATTLE_ROUND_ORDINALS[w]).filter(Boolean);
    if(nums.length) return nums;
  }
  const single = BATTLE_ROUND_ORDINALS[words[0]];
  return single ? [single] : [];
}

function buildPrimaryMissionSideHtml(mission, sideLabel, currentTurn, totalTurns){
  if(!mission){
    return `
      <div class="missionSide">
        <div class="missionSideHead">
          <div class="missionSideLabel">${escapeHtml(sideLabel)}</div>
          <div class="missionFlavor" style="margin-top:6px;">No Primary Mission could be determined — this side needs a resolved Detachment (and Deposition) on both sides first.</div>
        </div>
      </div>
    `;
  }
  const blocksHtml = mission.scoring.map(block => {
    const rounds = roundsForMissionHeader(block.header, totalTurns);
    const active = rounds.includes(currentTurn);
    const entriesHtml = block.entries.map(e => `
      <div class="missionEntry">
        <span>${e.plus ? '+ ' : ''}${escapeHtml(e.text)}</span>
        <span class="missionVP${e.cumulative ? ' cumulative' : ''}">${escapeHtml(e.vp)}</span>
      </div>
    `).join('');
    return `
      <div class="missionBlock${active ? ' missionBlockActive' : ''}">
        <div class="missionBlockHdr">${escapeHtml(block.header)}${active ? ' • THIS TURN' : ''}</div>
        ${block.when ? `<div class="missionBlockWhen">WHEN: ${escapeHtml(block.when)}</div>` : ''}
        ${entriesHtml}
      </div>
    `;
  }).join('');
  const actionHtml = mission.action ? `
    <div class="missionAction">
      <div class="missionActionName">🎯 ${escapeHtml(mission.action.displayName)} (Objective Action)</div>
      ${mission.action.rows.map(r => `<div class="missionActionRow"><b>${escapeHtml(r.label)}:</b> ${escapeHtml(r.text)}</div>`).join('')}
    </div>
  ` : '';
  return `
    <div class="missionSide">
      <div class="missionSideHead">
        <div class="missionSideLabel">${escapeHtml(sideLabel)}</div>
        <div class="missionName">${escapeHtml(mission.displayName)}</div>
        <div class="missionFlavor">${escapeHtml(mission.flavor)}</div>
      </div>
      ${blocksHtml}
      ${actionHtml}
    </div>
  `;
}

async function renderPrimaryMission(battleId, returnTab){
  setStatus('', 'STANDBY');
  const battle = await getBattleById(battleId);
  if(!battle){ renderBattleList(); return; }
  const tracker = ensureTracker(battle);
  const missionsData = await loadMissionsData();

  // Units (and Detachments) can be added mid-battle, not just before Start
  // Battle — a second Detachment showing up on a side that only had one
  // makes its Deposition ambiguous again, same real 40k rule as before.
  // Recomputed fresh every time this screen renders (nothing here is
  // cached), so a Deposition picked or changed elsewhere is always
  // reflected the next time this screen is opened — and this screen can
  // also resolve it directly, rather than sending the player away to fix
  // it and back again.
  const myNeedsChoice = needsDispositionChoice(battle.myUnits, battle.myActiveDetachmentId);
  const oppNeedsChoice = needsDispositionChoice(battle.opponentUnits, battle.opponentActiveDetachmentId);
  const hasMultipleDetachments = battle.myUnits.filter(u => u.isDetachment).length > 1 || battle.opponentUnits.filter(u => u.isDetachment).length > 1;

  // A resolved Detachment's card can still be an old, pre-disposition-field
  // snapshot (see withFreshDisposition) — heal it here too, same as the
  // Choose Active Detachment screen and the Detachment Rules card already
  // do, or this lookup would silently fail for a battle roster saved
  // before that field existed.
  const myDetach = resolveActiveDetachment(battle.myUnits, battle.myActiveDetachmentId);
  const oppDetach = resolveActiveDetachment(battle.opponentUnits, battle.opponentActiveDetachmentId);
  const myDisposition = myDetach && (await withFreshDisposition(myDetach.card)).disposition;
  const oppDisposition = oppDetach && (await withFreshDisposition(oppDetach.card)).disposition;

  const myMission = findPrimaryMission(missionsData, myDisposition, oppDisposition);
  const oppMission = findPrimaryMission(missionsData, oppDisposition, myDisposition);

  const whichSide = myNeedsChoice && oppNeedsChoice ? 'both armies' : myNeedsChoice ? 'My Army' : `${battle.opponent}'s Army`;
  const needsChoiceNote = (myNeedsChoice || oppNeedsChoice)
    ? `<div class="noteBox" style="border-color:var(--blood-bright); color:var(--parchment);">More than one Detachment is on ${escapeHtml(whichSide)} — pick which one's Deposition applies to see the right Primary Mission.</div>`
    : '';
  const detachButtonHtml = hasMultipleDetachments
    ? `<button class="btn ${(myNeedsChoice || oppNeedsChoice) ? 'gold' : 'ghost'}" id="resolveDispositionBtn" style="margin-bottom:14px;">${(myNeedsChoice || oppNeedsChoice) ? '⚠️ Choose Active Detachment' : '🔀 Change Active Detachment'}</button>`
    : '';

  main.innerHTML = `
    <div class="turnBadge">Turn ${tracker.turn}</div>
    ${needsChoiceNote}
    ${detachButtonHtml}
    ${!missionsData ? '<div class="noteBox">Could not load mission data — check your connection and try again.</div>' : ''}
    ${buildPrimaryMissionSideHtml(myMission, 'My Primary Mission', tracker.turn, TOTAL_TURNS)}
    ${buildPrimaryMissionSideHtml(oppMission, `${battle.opponent}'s Primary Mission`, tracker.turn, TOTAL_TURNS)}
  `;
  footer.style.display = 'flex';
  footer.innerHTML = `<button class="btn ghost" id="missionBackBtn" data-nav-back>← Back to Tracker</button>`;
  document.getElementById('missionBackBtn').onclick = () => renderBattleTracker(battleId, returnTab || 'tracker');
  if(document.getElementById('resolveDispositionBtn')){
    document.getElementById('resolveDispositionBtn').onclick = () => renderChooseActiveDetachment(battleId, () => renderPrimaryMission(battleId, returnTab));
  }
}

async function withFreshDisposition(card){
  if(!card || card.disposition) return card;
  const data = await loadDetachmentsData();
  const faction = data && data.factions && data.factions[normalizePointsName(card.faction || '')];
  const fresh = faction && faction.detachments[normalizePointsName(card.displayName || '')];
  return fresh && fresh.disposition ? Object.assign({}, card, { disposition: fresh.disposition }) : card;
}

function htmlToPlainText(html){
  return (html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li>/gi, '\n• ')
    .replace(/<\/li>/gi, '')
    .replace(/<\/?ul>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{2,}/g, '\n')
    .replace(/^\n+/, '')
    .trim();
}

// A unit name can map to more than one official datasheet — some units
// (e.g. Nurgle Daemon units like Nurglings or Plague Drones) have a
// genuinely separate datasheet per faction that can take them. See
// fetch-datasheets.mjs — every variant is kept under the same name key.
async function lookupOfficialDatasheetVariants(unitName){
  const data = await loadDatasheetsData();
  const key = findDatasetKey(data, unitName);
  if(!key) return [];
  const entry = data.units[key];
  // Tolerates the previous single-object-per-key schema too (not just the
  // current array-of-variants one) — the app and datasheets-data.json
  // deploy independently (this file's build vs. update-datasheets.yml's
  // own commit+deploy), so there's always a window where one has shipped
  // and the other hasn't yet.
  return Array.isArray(entry) ? entry : [entry];
}

// Picks one variant for callers that need a single result (bulk imports,
// or an interactive lookup that already knows which faction it wants):
// prefers a variant whose faction matches the given hint, and otherwise
// just takes the first. Interactive single-unit search instead calls
// lookupOfficialDatasheetVariants() directly so it can ask the user when
// there's more than one and no hint to go on — see fetchDatasheet().
async function lookupOfficialDatasheet(unitName, factionHint){
  const variants = await lookupOfficialDatasheetVariants(unitName);
  if(!variants.length) return null;
  const hint = (factionHint || '').toLowerCase().trim();
  if(hint){
    const match = variants.find(v => {
      const vf = (v.faction || '').toLowerCase();
      return vf && (vf.includes(hint) || hint.includes(vf));
    });
    if(match) return match;
  }
  return variants[0];
}

// Builds the same shape fetchDatasheet()/renderDatasheet() already expect
// from a Gemini response, directly from the scraped dataset — points are
// intentionally left blank/uncertain here since Wahapedia's export doesn't
// include them at all; lookupDatasheetRaw fills them in right after from
// the separate points dataset, same as it does for a Gemini-sourced result.
function buildParsedFromOfficialDatasheet(official, isLight){
  const base = {
    unit_name: official.displayName,
    faction: official.faction,
    points: '',
    points_uncertain: true,
    stats: official.stats,
    weapons: official.weapons,
  };
  if(isLight) return base;
  return Object.assign(base, {
    unit_composition: official.unit_composition,
    abilities: official.abilities,
    keywords: official.keywords,
    faction_keywords: official.faction_keywords,
  });
}

const main = document.getElementById('main');
const footer = document.getElementById('footer');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');

let stream = null;
let lastImageDataUrl = null;
// Lets the camera/upload flow be reused for both normal scanning and
// adding a custom model — set before opening the camera, reset in renderHome().
let onPhotoReady = null; // assigned once identifyFromImage is defined below
let onCameraCancel = null; // assigned once renderHome is defined below
// { battleId, team: 'my'|'opponent' } while a scan is being logged into a
// battle roster — null for a normal, non-battle scan. Set when the user
// picks a side in renderBattleScanChoice(); read by renderDatasheet() to
// decide whether to save the result. Reset to null in renderHome().
let currentBattleContext = null;

function setStatus(state, text){
  statusDot.className = 'dot' + (state ? ' '+state : '');
  statusText.textContent = text;
}

function clearFooter(){ footer.style.display='none'; footer.innerHTML=''; }

// ---------- PWA INSTALL ----------
// index.html's early inline script captures beforeinstallprompt (which can
// fire before this module loads) onto window.__deferredInstallPrompt and
// relays it via these custom events.
let installPromptEvt = (typeof window !== 'undefined' && window.__deferredInstallPrompt) || null;
let appInstalled = false;
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIos = /iphone|ipad|ipod/i.test(window.navigator.userAgent) && !window.MSStream;

function canInstall(){ return !isStandalone && !appInstalled; }

window.addEventListener('pwa-install-available', () => {
  installPromptEvt = window.__deferredInstallPrompt || null;
  if(document.getElementById('scanBtn') && !document.getElementById('installBtn')) renderHome();
});
window.addEventListener('pwa-installed', () => {
  installPromptEvt = null;
  appInstalled = true;
  if(document.getElementById('installBtn')) renderHome();
});

async function handleInstall(){
  // 1. Newer Web Install API (Chrome 139+): installs directly, no captured
  //    beforeinstallprompt event needed.
  if(typeof navigator !== 'undefined' && typeof navigator.install === 'function'){
    try{ await navigator.install(); return; }
    catch(e){ if(e && e.name === 'AbortError') return; /* else fall through */ }
  }
  // 2. Classic captured beforeinstallprompt event.
  const dp = installPromptEvt || (typeof window !== 'undefined' ? window.__deferredInstallPrompt : null);
  if(dp){
    dp.prompt();
    try{ await dp.userChoice; }catch(e){ /* ignore */ }
    installPromptEvt = null;
    if(typeof window !== 'undefined') window.__deferredInstallPrompt = null;
    return;
  }
  // 3. Nothing the browser will trigger programmatically — manual instructions.
  showManualInstallModal();
}

function showManualInstallModal(){
  const body = isIos
    ? 'Tap the Share icon in Safari, then choose "Add to Home Screen".'
    : 'Open your browser menu (⋮) and tap "Install app" — or "Add to Home screen" then "Install". Avoid "Create shortcut": that only opens in the browser.';
  const overlay = document.createElement('div');
  overlay.className = 'modalOverlay';
  overlay.innerHTML = `
    <div class="modalCard">
      <div class="modalTitle">Install WarCamera 4k</div>
      <div class="modalBody">${escapeHtml(body)}</div>
      <button class="btn primary" id="modalGotIt" style="margin-top:14px;">Got It</button>
    </div>
  `;
  overlay.addEventListener('click', (e) => { if(e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  document.getElementById('modalGotIt').onclick = () => overlay.remove();
}

// ---------- SCREEN: HOME ----------
function renderHome(){
  clearFooter();
  setStatus('', 'STANDBY');
  onPhotoReady = identifyFromImage;
  onCameraCancel = renderHome;
  currentBattleContext = null;
  main.innerHTML = `
    ${canInstall() ? '<button class="btn gold" id="installBtn">⬇ Install App</button>' : ''}
    <button class="btn primary" id="scanBtn">📷 Scan Miniature</button>
    <button class="btn ghost" id="uploadPhotoBtn" style="margin-top:-6px;">🖼 Upload a Photo Instead</button>
    <input type="file" id="uploadPhotoInput" accept="image/*" style="display:none;" />
    <button class="btn gold" id="uploadListBtn">📋 Paste an Army List</button>
    <input type="text" id="manualInput" placeholder="Type a unit or Detachment name" />
    <button class="btn gold" id="manualBtn">🔎 Look Up Datasheet</button>
    <button class="btn gold" id="battlesBtn">⚔️ Battles</button>
    <div class="divider">library</div>
    <button class="btn ghost" id="collectionBtn">📚 My Collection</button>
    <button class="btn ghost" id="customLibBtn">🧩 Custom Model Library</button>
    <button class="detailsToggle" id="apiKeyBtn">🔑 API Key Settings</button>
    <button class="detailsToggle" id="detailsToggleBtn">▾ Show App Details</button>
    <div class="noteBox" id="appDetailsBox" hidden>
      Visual identification is AI best-effort — paint jobs, conversions and unpainted models reduce accuracy.
      You'll be able to confirm or correct the result before stats are pulled up.
      Stats come from the AI's own knowledge, not a live lookup, so a recent points/balance update might not be reflected. Rule text is paraphrased, not quoted verbatim from Games Workshop.
      If your browser blocks camera access, Upload a Photo Instead works instead — it uses your device's normal photo picker rather than a live camera feed.
      Already built a list in an army builder app? Paste an Army List to pull in every unit from a plain-text export at once, after confirming what was found.
      Know the Detachment you're playing? Type its name (e.g. "Plague Legion") into Look Up Datasheet to pull up its rule, Enhancements, and Stratagems directly.
      Got your own conversions or proxies? Register them under Custom Model Library so future scans recognize them instantly.
      Scanned a unit before? Save it to My Collection from its datasheet screen, then reopen it or add it straight into a battle roster with no rescanning.
      Playing a game? Start a Battle to log which units you and your opponent have on the table, with one tap back to any datasheet.
    </div>
  `;
  document.getElementById('detailsToggleBtn').onclick = () => {
    const box = document.getElementById('appDetailsBox');
    const btn = document.getElementById('detailsToggleBtn');
    box.hidden = !box.hidden;
    btn.textContent = box.hidden ? '▾ Show App Details' : '▴ Hide App Details';
  };
  if(document.getElementById('installBtn')) document.getElementById('installBtn').onclick = handleInstall;
  document.getElementById('scanBtn').onclick = openCamera;

  document.getElementById('uploadPhotoBtn').onclick = () => {
    document.getElementById('uploadPhotoInput').click();
  };
  document.getElementById('uploadPhotoInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = () => identifyFromImage(reader.result);
    reader.onerror = () => renderIdError({message:'Could not read that file'}, null);
    reader.readAsDataURL(file);
  });
  document.getElementById('uploadListBtn').onclick = renderPasteListScreen;

  document.getElementById('customLibBtn').onclick = renderCustomLibrary;
  document.getElementById('collectionBtn').onclick = renderCollectionList;
  document.getElementById('battlesBtn').onclick = renderBattleList;
  document.getElementById('apiKeyBtn').onclick = renderApiKeySettings;

  document.getElementById('manualBtn').onclick = async () => {
    const v = document.getElementById('manualInput').value.trim();
    if(!v) return;
    // Check for a Detachment by that name first — same static, no-Gemini
    // source used when a list upload finds one — before falling back to a
    // normal unit lookup, so typing a Detachment name here (e.g. "Plague
    // Legion") shows its rules card instead of a failed unit search.
    setStatus('busy', 'RETRIEVING');
    renderLoading('CONSULTING ARCHIVES', `Checking "${v}"…`);
    const detachMatches = await findDetachmentByName(v);
    if(detachMatches.length === 1){ renderDetachmentSearchResult(detachMatches[0]); return; }
    if(detachMatches.length > 1){ renderDetachmentFactionPicker(v, detachMatches); return; }
    fetchDatasheet(v, '');
  };
  document.getElementById('manualInput').addEventListener('keydown', e=>{
    if(e.key==='Enter'){ document.getElementById('manualBtn').click(); }
  });
}

// ---------- SCREEN: CAMERA ----------
let currentFacing = 'environment';

async function openCamera(){
  clearFooter();
  setStatus('', 'STANDBY');

  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    renderCameraUnsupported();
    return;
  }

  // Check current permission state where supported, so we never blindly
  // fire a request that's guaranteed to silently fail.
  let permState = 'unknown';
  try{
    if(navigator.permissions && navigator.permissions.query){
      const status = await navigator.permissions.query({ name:'camera' });
      permState = status.state; // 'granted' | 'denied' | 'prompt'
    }
  }catch(e){ /* permissions API not supported for camera — treat as unknown */ }

  if(permState === 'denied'){
    renderCameraBlocked();
    return;
  }

  if(permState === 'granted'){
    renderCameraView();
    try{ await startCamera(currentFacing); }
    catch(err){ handleCameraError(err); }
    return;
  }

  // 'prompt' or 'unknown' — explain what's about to happen before triggering
  // the browser's native permission dialog.
  renderCameraPrime();
}

function renderCameraPrime(){
  main.innerHTML = `
    <div class="errBox" style="border-color:var(--brass); background:rgba(194,147,47,0.08);">
      <div class="errTitle" style="color:var(--brass);">Camera Access Needed</div>
      WarCamera 4k needs permission to use your camera to photograph miniatures.
      Tap below, then choose <strong>Allow</strong> when your browser asks.
    </div>
    <button class="btn primary" id="enableCamBtn" style="margin-top:16px;">📷 Enable Camera Access</button>
    <button class="btn ghost" id="cancelPrimeBtn" data-nav-back style="margin-top:10px;">← Cancel</button>
  `;
  document.getElementById('enableCamBtn').onclick = async () => {
    renderCameraView();
    try{ await startCamera(currentFacing); }
    catch(err){ handleCameraError(err); }
  };
  document.getElementById('cancelPrimeBtn').onclick = renderHome;
}

function renderCameraView(){
  main.innerHTML = `
    <div id="camWrap">
      <video id="video" autoplay playsinline muted></video>
      <div class="reticle">
        <div class="corner tl"></div><div class="corner tr"></div>
        <div class="corner bl"></div><div class="corner br"></div>
      </div>
    </div>
    <div class="camControls">
      <div class="smallCircle" id="camCancel" data-nav-back>✕</div>
      <div class="shutter" id="camShutter"></div>
      <div class="smallCircle" id="camFlip">⟳</div>
    </div>
    <canvas id="canvas"></canvas>
  `;
  document.getElementById('camCancel').onclick = () => { stopCamera(); (onCameraCancel || renderHome)(); };
  document.getElementById('camShutter').onclick = capturePhoto;
  document.getElementById('camFlip').onclick = async () => {
    currentFacing = currentFacing === 'environment' ? 'user' : 'environment';
    stopCamera();
    try{ await startCamera(currentFacing); }
    catch(err){ handleCameraError(err); }
  };
}

async function startCamera(facing){
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: facing }, audio:false
  });
  const video = document.getElementById('video');
  video.srcObject = stream;
}

function stopCamera(){
  if(stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; }
}

function handleCameraError(err){
  stopCamera();
  const name = err && err.name;
  if(name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError'){
    renderCameraBlocked();
  } else if(name === 'NotFoundError' || name === 'DevicesNotFoundError'){
    renderCameraNotFound();
  } else {
    renderCameraError(err);
  }
}

function renderCameraBlocked(){
  main.innerHTML = `
    <div class="errBox">
      <div class="errTitle">Camera Blocked</div>
      Camera access is currently blocked for this page, so the browser won't prompt again on its own. To fix it:
      <br><br>
      1. Tap the camera or lock icon in your address bar (or open your browser/app's Site Settings) and set Camera to <strong>Allow</strong>.<br>
      2. Reload this page.<br><br>
      If you're viewing this inside an embedded preview, the host page itself may be restricting camera access — opening the file directly in its own browser tab can resolve that.
    </div>
    <button class="btn primary" id="recheckBtn" style="margin-top:14px;">↺ Try Again</button>
    <button class="btn gold" id="manualBtnBlocked" style="margin-top:10px;">🔎 Search by Name Instead</button>
  `;
  document.getElementById('recheckBtn').onclick = openCamera;
  document.getElementById('manualBtnBlocked').onclick = renderManualSearch;
}

function renderCameraNotFound(){
  main.innerHTML = `
    <div class="errBox">
      <div class="errTitle">No Camera Found</div>
      This device doesn't appear to have a usable camera. You can still search for a unit by name.
    </div>
    <button class="btn gold" id="manualBtnNF" style="margin-top:14px;">🔎 Search by Name</button>
    <button class="btn ghost" id="homeBtnNF" data-nav-back style="margin-top:10px;">← Home</button>
  `;
  document.getElementById('manualBtnNF').onclick = renderManualSearch;
  document.getElementById('homeBtnNF').onclick = renderHome;
}

function renderCameraUnsupported(){
  main.innerHTML = `
    <div class="errBox">
      <div class="errTitle">Camera Not Available Here</div>
      This browser or environment doesn't support camera access. You can still search for a unit by name.
    </div>
    <button class="btn gold" id="manualBtnUnsup" style="margin-top:14px;">🔎 Search by Name</button>
    <button class="btn ghost" id="homeBtnUnsup" data-nav-back style="margin-top:10px;">← Home</button>
  `;
  document.getElementById('manualBtnUnsup').onclick = renderManualSearch;
  document.getElementById('homeBtnUnsup').onclick = renderHome;
}

function renderCameraError(err){
  main.innerHTML = `
    <div class="errBox">
      <div class="errTitle">WarCamera Link Failed</div>
      Something went wrong starting the camera (${err && err.message ? escapeHtml(err.message) : 'unknown error'}).
      You can still search for a unit by name below.
    </div>
    <input type="text" id="manualInput2" placeholder="Type a unit name..." style="margin-top:14px;"/>
    <button class="btn gold" id="manualBtn2" style="margin-top:10px;">🔎 Look Up Datasheet</button>
    <button class="btn ghost" id="backBtn" data-nav-back style="margin-top:10px;">← Back</button>
  `;
  document.getElementById('manualBtn2').onclick = () => {
    const v = document.getElementById('manualInput2').value.trim();
    if(v) fetchDatasheet(v, '');
  };
  document.getElementById('backBtn').onclick = renderHome;
}

function capturePhoto(){
  const video = document.getElementById('video');
  const canvas = document.getElementById('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const photo = canvas.toDataURL('image/jpeg', 0.85);
  stopCamera();
  (onPhotoReady || identifyFromImage)(photo);
}

// ---------- SCREEN: UPLOAD (photo or pasted army list) ----------
function renderPasteListScreen(){
  setStatus('', 'STANDBY');
  main.innerHTML = `
    <div class="noteBox">Paste a plain-text export from your army builder app below.</div>
    <textarea id="pasteListInput" placeholder="Please paste Text List here."></textarea>
    <button class="btn gold" id="parsePastedListBtn" style="margin-top:10px;">📋 Detect Units & Detachments</button>
    <button class="btn ghost" id="pasteListCancelBtn" data-nav-back>← Cancel</button>
  `;
  document.getElementById('parsePastedListBtn').onclick = () => {
    const text = document.getElementById('pasteListInput').value;
    if(!text.trim()) return;
    handleArmyListFile(text);
  };
  document.getElementById('pasteListCancelBtn').onclick = renderHome;
}

// Best-effort, format-agnostic army-list parser. Every army builder export
// we're aware of (BattleScribe, NewRecruit, WTC, GW's own app) shows each
// unit's name immediately followed by its points cost in parentheses — e.g.
// "Plague Marines (80 pts)" — since that's the one convention basically
// universal across list formats, unlike everything else about their layout
// (indentation, section headers, bullet styles all vary). Wargear/enhancement
// sub-lines are excluded by a prefix blocklist, plus indentation as a
// secondary signal for the one common shape that blocklist alone can't
// catch (see wargear-block tracking below). This is inherently
// approximate — export formats vary — which is exactly why the result
// always goes through a confirm screen with per-unit checkboxes before
// anything is added.
function parseArmyListText(text){
  // A bare quantity prefix ("3x ...", no bullet, no trailing points) isn't
  // in this list — it's handled naturally below: such a line never matches
  // headerRe (no trailing points cost) and falls through unmatched, same
  // end result without risking a genuine quantity-prefixed unit header
  // ("10x Necron Warrior (100 pts)") being excluded before it's even
  // tested against headerRe.
  const skipPrefixRe = /^(enhancement|warlord|wargear|relic|detachment|battle size|faction|points?:|export|roster|[•\-*▪◦›»])/i;
  // Brackets and parentheses are treated as interchangeable — some list
  // apps export "Unit Name [100 pts]" instead of "Unit Name (100 pts)".
  // A trailing colon is also allowed — some exporters write "Unit Name
  // [100 pts]:" right before that unit's own attached wargear/leader line.
  // A leading model-count ("10x Necron Warrior (100 pts)", quantity before
  // the name rather than after) is also accepted — some exporters put it
  // there instead of appending "x10" to the name. A leading short label
  // like "Char1: " (some character/HQ exports number each named slot) is
  // accepted too. Finally, unlike the bare trailing colon above, anything
  // AFTER that colon is now allowed and ignored — some exporters put the
  // unit's whole wargear loadout on the same line ("Char1: 1x Knight
  // Desecrator (355 pts): Warlord, Desecrator laser destructor, ...")
  // instead of on their own bulleted lines below; the wargear text itself
  // isn't needed since every unit gets freshly looked up by name anyway.
  const headerRe = /^(?:[A-Za-z][A-Za-z0-9]{0,19}\s*:\s*)?(?:\d+\s*[xX]\s*)?([A-Za-z][A-Za-z0-9'.,\- ]{1,60}?)\s*[\(\[]\s*(\d{1,4})\s*(?:pts?|points)\s*[\)\]]\s*(?::\s*.*)?$/i;
  const wargearSectionRe = /^wargear options?:?$/i;
  // An all-caps line that ISN'T itself a priced unit header is a section
  // label (BATTLELINE, DEDICATED TRANSPORT, ...) rather than a unit.
  const sectionLabelRe = /^[A-Z][A-Z \/&'-]{2,40}$/;
  // The list's own title/header often reuses the exact "Name (NNN pts)"
  // shape a unit line has (e.g. "My Death Guard Army (1000 Points)"), but
  // real Warhammer unit names never contain these words — a title does.
  const titleWordRe = /\b(army|list|roster|crusade|detachment|patrol|incursion|strike force|onslaught)\b/i;
  // A character's own attached-unit note, e.g. "• Leading: Plaguebearers[2]"
  // right under its header line — captured so the led unit can be moved to
  // sit directly after its character below, instead of wherever it happens
  // to fall elsewhere in the list. A trailing "[N]" index (some exporters'
  // way of disambiguating same-named units) is stripped since it isn't
  // resolved here — the led unit is matched by name only.
  const leadingRe = /^[•\-*▪◦›»]\s*(?:leading|leads|attached to|joined to)\s*:\s*(.+?)\s*(?:\[\d+\])?\s*$/i;
  // An explicit "Detachment: X" line names the detachment directly — used
  // below to look up that detachment's rule/enhancements/stratagems,
  // instead of being discarded like the rest of skipPrefixRe's matches.
  const detachmentLineRe = /^detachment\s*[:\-]\s*(.+)$/i;
  // An explicit "Faction: X" / "FACTION KEYWORD: X" line (common in
  // BattleScribe/NewRecruit-style exports) names the list's own faction
  // directly, often as "Broad Alignment - Specific Faction" (e.g. "Chaos -
  // Chaos Space Marines"). Captured here — before skipPrefixRe would
  // otherwise silently discard it — and used by runArmyListImport as a
  // faction hint so a unit with datasheet variants across several factions
  // (e.g. a Chaos Lord fieldable by more than one Chaos-aligned army)
  // resolves to the variant that actually matches this list, instead of
  // whichever variant happens to come first in the dataset.
  const factionLineRe = /^faction(?:\s*keyword)?\s*[:\-]\s*(.+)$/i;
  const units = [];
  const leaderRelations = [];
  const detachmentHints = [];
  let declaredFactionLine = null;
  let lastUnitIndex = -1;
  let title = null;
  // Many exporters list a unit's optional wargear as bare "Name (N pts)"
  // lines right after an explicit "Wargear Options:" label, with no bullet
  // to distinguish them from a real unit header — track that block so
  // those don't get mistaken for units of their own. A blank line or the
  // next section label always ends it; so does dropping back to the same
  // (or shallower) indentation as the label line, which catches the next
  // real unit header even when it follows immediately with no blank line
  // or section break in between.
  let inWargearBlock = false;
  let wargearIndent = 0;
  // A roster's own title/header (e.g. "Death Guard (2000 Points)") almost
  // always sits as the very first line, shaped exactly like a unit header —
  // but unlike a real unit, it's always set apart from the roster body by
  // a blank line or a structural line (faction/detachment info, a section
  // label) before the first actual unit. A flat, title-less list has no
  // such gap: its first line is immediately followed by another priced
  // unit line with nothing in between. So only treat the first header-
  // shaped line as a title when something other than a unit follows it —
  // otherwise a genuine first unit would get silently dropped.
  const lines = text.split(/\r?\n/);
  let sawFirstContentLine = false;
  for(let li = 0; li < lines.length; li++){
    const rawLine = lines[li];
    const indent = rawLine.match(/^[ \t]*/)[0].length;
    const line = rawLine.trim();
    if(!line){ inWargearBlock = false; continue; }
    const isFirstContentLine = !sawFirstContentLine;
    sawFirstContentLine = true;
    if(inWargearBlock && indent < wargearIndent) inWargearBlock = false;
    if(wargearSectionRe.test(line)){ inWargearBlock = true; wargearIndent = indent; continue; }
    if(sectionLabelRe.test(line) && !headerRe.test(line)){ inWargearBlock = false; continue; }
    const leadMatch = line.match(leadingRe);
    if(leadMatch && lastUnitIndex >= 0){
      const ledName = leadMatch[1].trim().replace(/\s{2,}/g, ' ');
      if(ledName) leaderRelations.push({ leaderIdx: lastUnitIndex, ledName });
      continue;
    }
    const detachMatch = line.match(detachmentLineRe);
    if(detachMatch){
      const dName = detachMatch[1].trim().replace(/\s{2,}/g, ' ');
      if(dName) detachmentHints.push(dName);
      continue;
    }
    const factionMatch = line.match(factionLineRe);
    if(factionMatch){
      const fName = factionMatch[1].trim().replace(/\s{2,}/g, ' ');
      if(fName && !declaredFactionLine) declaredFactionLine = fName;
      continue;
    }
    if(skipPrefixRe.test(line)) continue;
    const m = line.match(headerRe);
    if(!m || inWargearBlock) continue;
    if(isFirstContentLine){
      const nextLine = (lines[li+1] || '').trim();
      const nextIsAnotherUnit = nextLine && headerRe.test(nextLine);
      if(!nextIsAnotherUnit){
        // Capture the title's own text (e.g. "Chaos - Chaos Daemons -
        // Plague Legion") so it can be offered as the default folder name
        // below, instead of just discarding it.
        const titleName = m[1].trim().replace(/\s{2,}/g, ' ');
        if(titleName) title = titleName;
        continue;
      }
    }
    const name = m[1].trim().replace(/\s{2,}/g, ' ');
    if(!name || titleWordRe.test(name)) continue;
    // No dedup by name here — a real roster can legitimately field the
    // same unit choice more than once (e.g. two separate Nurglings units),
    // each a distinct entry in the confirm screen below.
    units.push({ n: name, pts: Number(m[2]) || 0 });
    lastUnitIndex = units.length - 1;
  }
  // Move each led unit to sit directly after the character leading it,
  // pulling it out of wherever it originally fell in the list. If more
  // than one unit shares that name, attaches to the first one not already
  // claimed by another leader.
  if(leaderRelations.length){
    const attachedAfter = new Map();
    const claimed = new Set();
    for(const rel of leaderRelations){
      const ledKey = rel.ledName.toLowerCase();
      const foundIdx = units.findIndex((u, idx) => idx !== rel.leaderIdx && !claimed.has(idx) && u.n.toLowerCase() === ledKey);
      if(foundIdx !== -1){
        attachedAfter.set(rel.leaderIdx, foundIdx);
        claimed.add(foundIdx);
      }
    }
    if(claimed.size){
      const reordered = [];
      for(let i = 0; i < units.length; i++){
        if(claimed.has(i)) continue;
        reordered.push(units[i]);
        if(attachedAfter.has(i)) reordered.push(units[attachedAfter.get(i)]);
      }
      units.length = 0;
      units.push(...reordered);
    }
  }
  return { units, title, detachmentHints, declaredFactionLine };
}

async function handleArmyListFile(text){
  const { units, title, detachmentHints, declaredFactionLine } = parseArmyListText(text);
  if(!units.length){
    renderArmyListParseError(`Didn't recognize any units in that list.`, text);
    return;
  }
  // Detachments are detected up front, from the list's text alone (no
  // per-unit datasheet lookups yet — those stay deferred to actually
  // saving, same as before, so an unchecked unit is never looked up for
  // nothing), so they can show up as their own checkable rows alongside
  // the units on the same confirm screen instead of being silently added
  // later with no chance to review them. Checked against every faction at
  // once (see findAnyFactionDetachmentsInList) rather than needing this
  // list's own faction resolved first, so detection doesn't depend on the
  // list having an explicit "Faction:" line or a title that happens to
  // match a known faction name.
  renderLoading('SCANNING LIST', 'Checking for Detachments…');
  const detectedDetachments = await findAnyFactionDetachmentsInList(text, detachmentHints);
  renderArmyListConfirm(units, text, title, detachmentHints, declaredFactionLine, detectedDetachments);
}

function renderArmyListParseError(message, rawText){
  main.innerHTML = `
    <div class="errBox">
      <div class="errTitle">Couldn't Read That List</div>
      ${escapeHtml(message)} WarCamera looks for lines shaped like "Unit Name (NNN pts)" — the convention most army-builder plain-text exports use.
    </div>
    <button class="btn primary" id="saveTextListBtn" style="margin-top:14px;">📋 Save as "Army List" Anyway</button>
    <button class="btn gold" id="listErrRetryBtn">↺ Try Again</button>
    <button class="btn ghost" id="listErrBackBtn" data-nav-back>← Home</button>
  `;
  document.getElementById('saveTextListBtn').onclick = async () => {
    await addTextListToCollection(rawText, 'Army List');
    renderTextListSaved('Army List');
  };
  document.getElementById('listErrRetryBtn').onclick = renderPasteListScreen;
  document.getElementById('listErrBackBtn').onclick = renderHome;
}

// The pasted list itself shows up as one more checkbox in the same list of
// selectable units — no separate name field or second button — so adding
// it to My Collection is exactly the same one-tap action as adding any of
// the individual units found in it.
function renderArmyListConfirm(units, rawText, title, detachmentHints, declaredFactionLine, detectedDetachments){
  setStatus('', 'STANDBY');
  const detachments = detectedDetachments || [];
  // Detachments are listed above the units, each as its own checkbox — same
  // "found it, uncheck if wrong" pattern as a unit row, just styled like the
  // Detachment Rules cards seen elsewhere (📜 ... Rules) so it's clear these
  // are detachment-level rules, not another unit.
  const detachRows = detachments.map((d, i) => `
    <label class="libCard" style="display:flex; align-items:center; gap:10px; cursor:pointer;">
      <input type="checkbox" class="listDetachCheck" data-idx="${i}" checked style="width:18px; height:18px; flex-shrink:0;"/>
      <span class="libName" style="margin:0;">📜 ${escapeHtml(d.displayName || 'Detachment')} Rules</span>
    </label>
  `).join('');
  const rows = units.map((u, i) => `
    <label class="libCard" style="display:flex; align-items:center; gap:10px; cursor:pointer;">
      <input type="checkbox" class="listUnitCheck" data-idx="${i}" checked style="width:18px; height:18px; flex-shrink:0;"/>
      <span class="libName" style="margin:0;">${escapeHtml(u.n)}</span>
    </label>
  `).join('');
  const detachNote = detachments.length ? ` and ${detachments.length} Detachment${detachments.length===1?'':'s'}` : '';
  main.innerHTML = `
    <div class="noteBox">Found ${units.length} unit${units.length===1?'':'s'}${detachNote} in your list. Uncheck anything that isn't right — everything gets saved into one new Collection folder (each checked unit freshly looked up, same as a name search, plus the full list text), ready to add to a battle in one action later.</div>
    <input type="text" id="folderNameInput" placeholder="Name this folder (optional)" />
    ${detachRows}
    ${rows}
    <button class="btn primary" id="confirmListImportBtn" style="margin-top:14px;">💾 Save to a New Folder</button>
    <button class="btn ghost" id="cancelListImportBtn" data-nav-back>✕ Cancel</button>
  `;
  document.getElementById('confirmListImportBtn').onclick = () => {
    const selectedUnits = units.filter((u, i) => document.querySelector(`.listUnitCheck[data-idx="${i}"]`).checked);
    const selectedDetachments = detachments.filter((d, i) => document.querySelector(`.listDetachCheck[data-idx="${i}"]`).checked);
    const folderName = document.getElementById('folderNameInput').value.trim();
    runArmyListImport(selectedUnits, rawText, folderName, title, detachmentHints, declaredFactionLine, selectedDetachments);
  };
  document.getElementById('cancelListImportBtn').onclick = renderHome;
}

function renderTextListSaved(label){
  setStatus('', 'LINK ESTABLISHED');
  main.innerHTML = `
    <div class="noteBox">Saved "${escapeHtml(label || 'Imported List')}" to My Collection as a text document.</div>
    <button class="btn primary" id="listSaveDoneBtn">📚 View My Collection</button>
    <button class="btn ghost" id="listSaveHomeBtn" data-nav-back>🏠 Home</button>
  `;
  document.getElementById('listSaveDoneBtn').onclick = renderCollectionList;
  document.getElementById('listSaveHomeBtn').onclick = renderHome;
}

// Falls back to the list's own title line if it had one, otherwise builds
// a "<Faction> · <NNN pts> · <Date>" name from what got looked up — the
// faction most of the selected units share, the list's own stated point
// total (summed straight from the pasted text, not a rescan), and today's
// date — so a folder never ends up unnamed just because the user skipped
// naming it.
// The faction most of a list's looked-up datasheets share — used both as
// the default folder-name fallback and to know which faction's detachment
// list to check a pasted list against for Detachment Rules cards.
function computeMajorityFaction(datasheets){
  const factionCounts = {};
  for(const d of datasheets){
    const f = (d.faction || '').trim();
    if(!f) continue;
    factionCounts[f] = (factionCounts[f] || 0) + 1;
  }
  let topFaction = '';
  let topCount = 0;
  for(const [f, c] of Object.entries(factionCounts)){
    if(c > topCount){ topFaction = f; topCount = c; }
  }
  return topFaction;
}

// Tries to identify which known faction a pasted list is actually for,
// before any unit has been looked up — from an explicit "Faction:" /
// "FACTION KEYWORD:" line if the exporter wrote one (captured by
// parseArmyListText as declaredFactionLine), and otherwise from the list's
// own title line. Both often read like "Chaos - Chaos Space Marines"
// (broad alignment, then the specific faction) rather than a bare faction
// name, so each candidate is tried whole and split on " - "/commas, always
// as an EXACT match against a real faction name — never substring — so a
// broad segment like "Chaos" alone can never falsely resolve to one of
// several same-alignment factions (Chaos Daemons, Chaos Space Marines,
// Chaos Knights, ...). Used as a faction hint for every per-unit datasheet
// lookup below, so a unit with variants across more than one faction (e.g.
// a Chaos Lord several Chaos-aligned armies can field) resolves to the
// variant that actually matches this list, instead of whichever variant
// happens to come first in the dataset.
function resolveDeclaredFaction(candidates, detachmentsData){
  if(!detachmentsData || !detachmentsData.factions) return '';
  for(const candidate of candidates){
    if(!candidate) continue;
    const pieces = candidate.split(/\s+-\s+|,/).map(p => p.trim()).filter(Boolean);
    pieces.push(candidate.trim());
    for(const piece of pieces){
      const key = normalizePointsName(piece);
      const faction = key && detachmentsData.factions[key];
      if(faction) return faction.displayName || piece;
    }
  }
  return '';
}

function buildDefaultFolderName(title, units, datasheets){
  if(title) return title;
  const totalPts = units.reduce((sum, u) => sum + (u.pts || 0), 0);
  const topFaction = computeMajorityFaction(datasheets);
  const dateStr = formatBattleDate(new Date().toISOString().slice(0,10));
  const parts = [];
  if(topFaction) parts.push(topFaction);
  if(totalPts) parts.push(`${totalPts} pts`);
  parts.push(dateStr);
  return parts.join(' · ');
}

// Every string worth trying as a detachment name from a pasted list: each
// explicit "Detachment: X" hint (captured by parseArmyListText), every
// non-blank line whole, and — since some exporters embed the detachment
// name as one hyphen-separated segment of an informal title line (e.g.
// "Chaos - Chaos Daemons - Plague Legion - [2000 pts]") rather than a line
// of its own — every " - "-separated segment of that line too, with a
// trailing points bracket stripped if the segment carries one. Every
// candidate is also tried split on commas, since some exporters list two
// detachments taken together as "Detachment A, Detachment B" within a
// single segment (e.g. "Xenos - Necrons - Cursed Legion, Hand of the
// Dynasty" — a real two-detachment Necrons list) rather than one per line.
// Shared by findDetachmentsInList (matched against one known faction) and
// findAnyFactionDetachmentsInList (matched against all of them) below —
// candidates that don't happen to match anything real are harmless either
// way, so it's safe to generate the same broad set for both.
function candidateDetachmentNames(rawText, detachmentHints){
  const names = [];
  const pushCandidate = (candidateName) => {
    names.push(candidateName);
    if(candidateName.includes(',')){
      for(const piece of candidateName.split(',')){
        const trimmed = piece.trim();
        if(trimmed) names.push(trimmed);
      }
    }
  };
  for(const hint of detachmentHints) pushCandidate(hint);
  for(const rawLine of rawText.split(/\r?\n/)){
    const line = rawLine.trim();
    if(!line) continue;
    pushCandidate(line);
    const segments = line.split(/\s+-\s+/);
    if(segments.length > 1){
      for(const seg of segments){
        const cleaned = seg.replace(/\s*[\(\[]\s*\d[\d,]*\s*(?:pts?|points)\s*[\)\]]\s*$/i, '').trim();
        if(cleaned) pushCandidate(cleaned);
      }
    }
  }
  return names;
}

// Finds which detachments a pasted list actually uses, checking every
// faction's detachments at once — no resolved faction needed, so this runs
// right after parsing (before any per-unit datasheet lookup has revealed
// which faction the list is even for), letting a detected Detachment show
// up as its own checkbox on the confirm screen immediately. See
// handleArmyListFile. An exact match only (never substring) — either an
// explicit "Detachment: X" hint (captured by parseArmyListText) or a whole
// line/segment matching a real detachment name — so a made-up nickname like
// "2 Bigs" that just doesn't match anything real is never mistaken for one.
// Supports more than one match, so a list naming several detachments gets a
// card for each. The one detachment name known to
// collide across factions in the current dataset ("Infestation Swarm" —
// Genestealer Cults and Tyranids both have one) resolves to whichever
// faction is checked first — a narrow, pre-existing ambiguity, same as
// findDetachmentByName's own multi-match search below.
async function findAnyFactionDetachmentsInList(rawText, detachmentHints){
  const data = await loadDetachmentsData();
  if(!data || !data.factions) return [];
  const found = new Map();
  for(const candidate of candidateDetachmentNames(rawText, detachmentHints)){
    const key = normalizePointsName(candidate);
    if(!key || found.has(key)) continue;
    for(const faction of Object.values(data.factions)){
      const detachment = faction.detachments[key];
      if(detachment){ found.set(key, detachment); break; }
    }
  }
  return [...found.values()];
}

// Lets the same "Look Up Datasheet" search box find a Detachment by name,
// not just a unit — same static, no-Gemini-call source as
// findDetachmentsInList above. Exact normalized-name match first (across
// every faction, since the search box has no faction context to narrow
// by); if nothing matches exactly, falls back to a substring match so a
// partial or slightly-off name still finds something, same pattern as
// findDatasetKey's unit lookup. Only one detachment name collides across
// factions in the current dataset ("Infestation Swarm" — Genestealer
// Cults and Tyranids both have one), but a substring search can turn up
// several unrelated detachments too, so this always returns every match
// for the caller to disambiguate rather than guessing.
async function findDetachmentByName(query){
  const data = await loadDetachmentsData();
  if(!data || !data.factions) return [];
  const key = normalizePointsName(query);
  if(!key) return [];

  const exact = [];
  const substring = [];
  for(const faction of Object.values(data.factions)){
    for(const [dKey, card] of Object.entries(faction.detachments)){
      if(dKey === key) exact.push(card);
      else if(dKey.length > 2 && (key.includes(dKey) || dKey.includes(key))) substring.push(card);
    }
  }
  return exact.length ? exact : substring;
}

async function runArmyListImport(units, rawText, folderName, title, detachmentHints, declaredFactionLine, selectedDetachments){
  setStatus('busy', 'IMPORTING');
  const detachmentsData = await loadDetachmentsData();
  const declaredFaction = resolveDeclaredFaction([declaredFactionLine, title], detachmentsData);
  // The folder holds reference datasheets, not a battle roster — fielding
  // the same unit more than once (e.g. two Plaguebearers units) doesn't
  // need a second identical reference page, so only the first occurrence
  // of each name gets looked up and saved.
  const seen = new Set();
  const uniqueUnits = units.filter(u => {
    const key = u.n.toLowerCase();
    if(seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const dupeCount = units.length - uniqueUnits.length;
  const datasheets = [];
  const failed = [];
  for(let i=0;i<uniqueUnits.length;i++){
    renderLoading('IMPORTING LIST', `Looking up ${i+1} of ${uniqueUnits.length}: ${uniqueUnits[i].n}…`);
    try{
      const d = await lookupDatasheetRaw(uniqueUnits[i].n, declaredFaction, false);
      datasheets.push(d);
    }catch(err){
      failed.push(uniqueUnits[i].n);
    }
  }
  // Detachments were already detected and shown as their own checkboxes on
  // the confirm screen (see handleArmyListFile/findAnyFactionDetachmentsInList)
  // — the user's picks there (possibly none, if every one got unchecked)
  // are honored as-is rather than re-detecting.
  const detachmentCards = selectedDetachments || [];
  // Every list upload creates exactly one new folder — the selected units
  // (freshly looked up, one reference page per unique unit), the full
  // pasted text, and a Detachment Rules card for each detachment the list
  // is confidently recognized as using, all kept together instead of
  // scattered flat into My Collection, so the whole thing can be added to a
  // battle roster in one action later. The points total below still
  // reflects every selected occurrence, not just the unique ones, so it
  // matches the list's real cost.
  const finalName = folderName || buildDefaultFolderName(title, units, datasheets);
  await addUnitsToCollectionFolder(datasheets, finalName, rawText, detachmentCards);
  setStatus('', 'LINK ESTABLISHED');
  const detachNote = detachmentCards.length ? ` Also added Detachment Rules for ${detachmentCards.map(d => escapeHtml(d.displayName)).join(', ')}.` : '';
  main.innerHTML = `
    <div class="noteBox">Saved "${escapeHtml(finalName)}" to My Collection — ${datasheets.length} unique unit${datasheets.length===1?'':'s'}${dupeCount ? ' ('+dupeCount+' duplicate'+(dupeCount===1?'':'s')+' skipped — one reference page per unit is enough)' : ''} plus the full list text.${detachNote}${failed.length ? ' Couldn\'t confidently look up: '+failed.map(n=>escapeHtml(n)).join(', ')+' — try adding those individually.' : ''}</div>
    <button class="btn primary" id="listImportDoneBtn">📚 View My Collection</button>
    <button class="btn ghost" id="listImportHomeBtn" data-nav-back>🏠 Home</button>
  `;
  document.getElementById('listImportDoneBtn').onclick = renderCollectionList;
  document.getElementById('listImportHomeBtn').onclick = renderHome;
}


// ---------- LOADING ----------
function renderLoading(status, sub){
  clearFooter();
  main.innerHTML = `
    <div class="loadWrap">
      <div class="cog"></div>
      <div class="loadStatus">${status}</div>
      <div class="loadSub">${sub||''}</div>
    </div>
  `;
}

// ---------- API HELPERS ----------
function extractText(data){
  const parts = data && data.candidates && data.candidates[0] &&
    data.candidates[0].content && data.candidates[0].content.parts;
  if(!parts) return '';
  return parts.map(p => p.text || '').filter(Boolean).join('\n');
}

function parseJsonLoose(text){
  const cleaned = text.replace(/```json/gi,'').replace(/```/g,'').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  const slice = start>=0 && end>=0 ? cleaned.slice(start,end+1) : cleaned;
  try{
    return JSON.parse(slice);
  }catch(e){
    console.error('JSON parse failed. Raw response was:', text);
    // Surface a snippet of what the model actually said (most often it got
    // cut off mid-JSON by hitting the output token cap) instead of just a
    // generic message — otherwise diagnosing this needs browser devtools.
    const preview = (text || '').trim().slice(-200);
    throw new Error(
      'Got an incomplete or malformed response — please try again.' +
      (preview ? ' (end of response: "' + preview + '")' : '')
    );
  }
}

// ---------- SHARED RENDER HELPERS ----------
function buildStatGridHtml(s){
  s = s || {};
  let html = `
    <div class="statGrid">
      <div class="statCell"><div class="statLabel">M</div><div class="statVal">${escapeHtml(s.movement||'-')}</div></div>
      <div class="statCell"><div class="statLabel">T</div><div class="statVal">${escapeHtml(s.toughness||'-')}</div></div>
      <div class="statCell"><div class="statLabel">SV</div><div class="statVal">${escapeHtml(s.save||'-')}</div></div>
      <div class="statCell"><div class="statLabel">W</div><div class="statVal">${escapeHtml(s.wounds||'-')}</div></div>
      <div class="statCell"><div class="statLabel">LD</div><div class="statVal">${escapeHtml(s.leadership||'-')}</div></div>
      <div class="statCell"><div class="statLabel">OC</div><div class="statVal">${escapeHtml(s.oc||'-')}</div></div>
    </div>`;
  if(s.invulnerable_save){
    html += `<div class="section" style="padding:8px 16px; border-bottom:1px solid var(--iron);"><span class="statLabel">INVULNERABLE SAVE</span> <span class="statVal" style="font-size:13px;">${escapeHtml(s.invulnerable_save)}</span></div>`;
  }
  return html;
}

function buildWeaponsTableHtml(weapons){
  const rows = (weapons||[]).map(w=>`
    <tr>
      <td><span class="wName">${escapeHtml(w.name||'')}</span><span class="wType">${escapeHtml(w.type||'')}${w.abilities?' · '+escapeHtml(w.abilities):''}</span></td>
      <td>${escapeHtml(w.range||'-')}</td>
      <td>${escapeHtml(w.attacks||'-')}</td>
      <td>${escapeHtml(w.skill||'-')}</td>
      <td>${escapeHtml(w.strength||'-')}</td>
      <td>${escapeHtml(w.ap||'-')}</td>
      <td>${escapeHtml(w.damage||'-')}</td>
    </tr>
  `).join('');
  if(!rows) return '';
  return `
    <div class="section">
      <div class="sectionTitle">Weapons</div>
      <table class="weapons">
        <thead><tr><th>Name</th><th>Rng</th><th>A</th><th>Sk</th><th>S</th><th>AP</th><th>D</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// Downscale before sending — phone camera photos and uploads can be
// several times larger than a vision model needs, and that extra size
// only adds upload/processing time, not identification accuracy.
function resizeImageDataUrl(dataUrl, maxDim, quality){
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if(width > maxDim || height > maxDim){
        if(width >= height){ height = Math.round(height * (maxDim/width)); width = maxDim; }
        else{ width = Math.round(width * (maxDim/height)); height = maxDim; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl); // fall back to original if it fails
    img.src = dataUrl;
  });
}

// ---------- CUSTOM MODEL LIBRARY ----------
async function addCustomModel(entry){
  const list = await loadCustomModels();
  entry.id = uid('cm_');
  list.unshift(entry);
  // cap the library so the per-scan reference payload stays bounded
  await saveCustomModelsList(list.slice(0, 12));
}

async function deleteCustomModel(id){
  const list = await loadCustomModels();
  await saveCustomModelsList(list.filter(m => m.id !== id));
}

// ---------- PHASE 1: VISION ID ----------
async function identifyFromImage(rawDataUrl){
  setStatus('busy', 'SCANNING');
  renderLoading('ANALYSING PATTERN', 'Cross-referencing visual signature…');

  const dataUrl = await resizeImageDataUrl(rawDataUrl, 1600, 0.82);
  lastImageDataUrl = dataUrl;

  const base64 = dataUrl.split(',')[1];
  const customModels = await loadCustomModels();

  const parts = [];
  if(customModels.length){
    parts.push({ text:
`The user has personally registered the following custom or converted miniatures, each assigned to a specific unit. Before general identification, check whether the NEW PHOTO (shown last) is clearly the SAME physical miniature as one of these — same conversion, same pose, same specific model, not merely the same generic unit type. Each reference below is labeled with a custom_id.` });
    customModels.forEach(m => {
      parts.push({ text: `Reference [custom_id: ${m.id}] — label "${m.label}", assigned to unit "${m.unitName}"${m.faction ? ' ('+m.faction+')' : ''}:` });
      const refBase64 = (m.thumb || '').split(',')[1];
      if(refBase64){
        parts.push({ inline_data:{ mime_type:'image/jpeg', data: refBase64 } });
      }
    });
    parts.push({ text: 'NEW PHOTO to identify:' });
  }
  parts.push({ inline_data:{ mime_type:'image/jpeg', data: base64 } });

  parts.push({ text:
`You are looking at a photo of a Warhammer 40,000 tabletop miniature${customModels.length ? ' (the NEW PHOTO above)' : ''}. ${customModels.length ? 'First check it against the numbered custom references above for a strong visual match — if it clearly matches one, use the assigned unit_name/faction from that reference and set matched_custom_id. Otherwise, ' : ''}identify which current 11th-edition unit datasheet this model most likely represents.

Before answering, look closely at distinguishing physical details rather than just overall silhouette or faction theme — many large monster/character models from the same faction look similar at a glance but differ in specifics. Check things like: exact head count, what (if anything) is held in each hand (staff vs sword vs no weapon), wing type and shape, leg count and stance, what the limbs end in (gun barrels vs blades vs claws vs cannons), base size, and any unique iconography or asymmetry. Commonly confused pairs include, for example: Kairos Fateweaver (two heads, carries a staff) vs Magnus the Red (one head, no staff, more armoured/sorcerous look) among large Tzeentch models; and among Chaos daemon engines, Forgefiend (four legs, quadrupedal, two large paired ranged-weapon arms/cannon barrels, no melee weapon) vs Maulerfiend (four legs, quadrupedal, one arm ending in a large chain-weapon/blade for melee, no paired gun arms) vs Defiler (six legs/spider-like stance, taller overall, one large cannon plus one large claw arm) — use that kind of feature-level comparison for any faction, not just these examples.

Respond with ONLY valid JSON, no markdown fences, no preamble, in exactly this shape:
{"matched_custom_id": "the custom_id if this is clearly one of the registered custom models above, else null", "reasoning": "1-2 sentences on the specific visual features you compared and why they point to your answer", "identified": true or false, "unit_name": "your single best-match unit name (or the matched custom model's assigned unit)", "faction": "...", "confidence": "high"|"medium"|"low", "notes": "one short sentence about paint scheme, conversion, or ambiguity if relevant, else empty string"}
Give only your single best match, not a ranked list. Do not include any text outside the JSON object.`
  });

  try{
    const data = await callGemini({
      contents: [{ role: 'user', parts }],
      generationConfig: { maxOutputTokens: 2000 },
    }, { model: VISION_MODEL });

    const text = extractText(data);
    const parsed = parseJsonLoose(text);

    if(!parsed.unit_name){
      throw new Error('No match returned');
    }

    fetchDatasheet(parsed.unit_name, parsed.faction, 'confirm');

  }catch(err){
    renderIdError(err, dataUrl);
  }
}

function renderIdError(err, dataUrl){
  setStatus('err', 'LINK ERROR');
  main.innerHTML = `
    <div class="errBox">
      <div class="errTitle">Identification Failed</div>
      Couldn't get a clear read on that model (${escapeHtml(err.message||'unknown error')}). Try a clearer, closer shot, better lighting, or search by name instead.
    </div>
    <button class="btn primary" id="retryBtn" style="margin-top:14px;">↺ Try Again</button>
    <button class="btn gold" id="manualBtn3" style="margin-top:10px;">🔎 Search by Name</button>
  `;
  document.getElementById('retryBtn').onclick = openCamera;
  document.getElementById('manualBtn3').onclick = renderManualSearch;
}

function renderManualSearch(){
  setStatus('', 'STANDBY');
  main.innerHTML = `
    <input type="text" id="manualInput3" placeholder="Type a unit name..." />
    <button class="btn gold" id="manualBtn4" style="margin-top:10px;">🔎 Look Up Datasheet</button>
    <button class="btn ghost" id="homeBtn" data-nav-back style="margin-top:10px;">← Home</button>
  `;
  document.getElementById('manualBtn4').onclick = () => {
    const v = document.getElementById('manualInput3').value.trim();
    if(v) fetchDatasheet(v, '', 'direct');
  };
  document.getElementById('homeBtn').onclick = renderHome;
}

// ---------- SCREEN: API KEY SETTINGS ----------
async function renderApiKeySettings(){
  clearFooter();
  setStatus('', 'STANDBY');

  const currentKey = await loadUserApiKey();
  const masked = currentKey ? '•'.repeat(Math.max(0, currentKey.length - 4)) + currentKey.slice(-4) : '';

  main.innerHTML = `
    <div class="noteBox">
      By default this app uses a shared API key so it works with zero setup. If you'd rather use your own free Gemini API key — so your usage never competes with anyone else's — paste it below. Your key is stored only on this device (never on any server), and is sent along with each request to this app's worker, which forwards it straight to Google for that one request and never stores or logs it.
    </div>
    ${currentKey ? `<div class="noteBox" style="border-top:none; padding-top:0;">Currently using your own key: <strong>${escapeHtml(masked)}</strong></div>` : ''}
    <input type="password" id="apiKeyInput" placeholder="Paste your Gemini API key" value="${currentKey ? escapeHtml(currentKey) : ''}" />
    <button class="btn primary" id="saveKeyBtn" style="margin-top:10px;">✓ Save &amp; Use My Key</button>
    ${currentKey ? '<button class="btn ghost" id="clearKeyBtn">✕ Stop Using My Key</button>' : ''}
    <button class="btn ghost" id="getKeyBtn">🔗 Get a Free Key from Google AI Studio</button>
    <button class="btn ghost" id="settingsHomeBtn" data-nav-back>🏠 Home</button>
  `;

  document.getElementById('saveKeyBtn').onclick = async () => {
    const input = document.getElementById('apiKeyInput');
    const val = input.value.trim();
    if(!val){ input.focus(); return; }
    await saveUserApiKey(val);
    renderApiKeySettings();
  };
  if(currentKey){
    document.getElementById('clearKeyBtn').onclick = async () => {
      await saveUserApiKey('');
      renderApiKeySettings();
    };
  }
  document.getElementById('getKeyBtn').onclick = () => {
    window.open('https://aistudio.google.com/apikey', '_blank', 'noopener');
  };
  document.getElementById('settingsHomeBtn').onclick = renderHome;
}

// ---------- BATTLES ----------
function formatBattleDate(dateStr){
  if(!dateStr) return '';
  try{
    return new Date(dateStr + 'T00:00:00').toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' });
  }catch(e){ return dateStr; }
}

async function getBattleById(id){
  const list = await loadBattles();
  return list.find(b => b.id === id) || null;
}

async function createBattle(opponent, date){
  const list = await loadBattles();
  const battle = { id: uid('battle_'), opponent, date, createdAt: Date.now(), myUnits: [], opponentUnits: [] };
  list.unshift(battle);
  await saveBattlesList(list);
  return battle;
}

async function deleteBattle(battleId){
  const list = await loadBattles();
  await saveBattlesList(list.filter(b => b.id !== battleId));
}

// Stores a copy of the datasheet — not a reference to it — so a battle's
// roster stays intact even if the same unit gets rescanned differently later.
async function addUnitToBattle(battleId, team, unit){
  const list = await loadBattles();
  const battle = list.find(b => b.id === battleId);
  if(!battle) return;
  const entry = Object.assign({}, unit, { id: uid('u_'), addedAt: Date.now() });
  (team === 'my' ? battle.myUnits : battle.opponentUnits).push(entry);
  await saveBattlesList(list);
}

async function removeUnitFromBattle(battleId, team, unitId){
  const list = await loadBattles();
  const battle = list.find(b => b.id === battleId);
  if(!battle) return;
  const key = team === 'my' ? 'myUnits' : 'opponentUnits';
  battle[key] = battle[key].filter(u => u.id !== unitId);
  await saveBattlesList(list);
}

// ---------- BATTLE TRACKER (live in-game VP/CP/secondaries/turn) ----------
// Battles created before this feature has no .tracker at all — this lazily
// gives it the default shape in place, so every tracker screen can just
// read battle.tracker without an existence check of its own. Points come
// from two places per side, matching how 40k is actually scored: primaryVP
// is typed in directly by the player (primary scoring is read off the
// mission's own scoring table, not something this app knows), while
// secondary VP is never typed in at all — it's the sum of whichever
// free-form secondaries that side has ticked as scored (see totalVP).
function ensureTracker(battle){
  if(!battle.tracker){
    battle.tracker = {
      started: false, finished: false, turn: 1,
      my: { cp: 0, primaryVP: 0, secondaries: [] },
      opponent: { cp: 0, primaryVP: 0, secondaries: [] },
    };
  }
  return battle.tracker;
}

// Achieved secondaries are discarded, not left ticked in place (see
// achieveSecondaryCard) — the VP they're worth lives in completedSecondaries
// from that point on, not on the active card anymore.
function totalVP(side){
  const secondaryVP = (side.completedSecondaries || []).reduce((sum, s) => sum + (s.vp || 0), 0);
  return (side.primaryVP || 0) + secondaryVP;
}

function normalizeMissionKey(name){
  return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Only the successful result gets cached — a transient failure (a flaky
// mobile connection dropping this one fetch) used to poison the cache with
// a resolved-to-null promise for the rest of the session, silently
// breaking every draw/redraw from then on with no way to recover short of
// a full reload. A failed attempt now just tries again next time it's
// needed instead.
let secondaryMissionsDataPromise = null;
function loadSecondaryMissionsData(){
  if(secondaryMissionsDataPromise) return secondaryMissionsDataPromise;
  const attempt = fetch('/secondary-missions-data.json')
    .then(r => r.ok ? r.json() : null)
    .catch(() => null);
  secondaryMissionsDataPromise = attempt;
  attempt.then(result => { if(!result) secondaryMissionsDataPromise = null; });
  return attempt;
}

// Re-hydrates a card's flavor/scoring/action from the current mission data
// whenever they're missing — a safety net for a stored card ending up
// incomplete by whatever means (a failed fetch caught mid-draw, corrupted
// storage, anything else not yet understood), so the achieve screen always
// has something to show rather than silently rendering a near-empty card.
async function withFreshSecondaryData(card){
  if(card.flavor && card.scoring && card.scoring.length) return card;
  const missionsData = await loadSecondaryMissionsData();
  if(!missionsData) return card;
  const fresh = missionsData.missions.find(m => normalizeMissionKey(m.displayName) === card.key);
  if(!fresh) return card;
  return { ...card, flavor: fresh.flavor, intro: fresh.intro, scoring: fresh.scoring, action: fresh.action };
}

function shuffled(arr){
  const a = arr.slice();
  for(let i = a.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Lazily backfills the draw-deck fields onto a tracker side — battles
// started before this feature existed have a side with none of them yet —
// and builds its shuffled deck the first time it's needed, excluding
// whatever's already active/completed/discarded so re-running this on an
// already-playing side is a safe no-op.
function ensureSecondaryDeck(side, allMissionKeys){
  if(!side.secondaries) side.secondaries = [];
  if(!side.completedSecondaries) side.completedSecondaries = [];
  if(!side.secondaryDiscardKeys) side.secondaryDiscardKeys = [];
  if(!side.secondaryDeckKeys){
    const inUse = new Set([
      ...side.secondaries.map(s => s.key),
      ...side.completedSecondaries.map(s => s.key),
      ...side.secondaryDiscardKeys,
    ]);
    side.secondaryDeckKeys = shuffled(allMissionKeys.filter(k => !inUse.has(k)));
  }
  if(side.secondaryLastDrawnTurn === undefined) side.secondaryLastDrawnTurn = 0;
  if(side.usedNewOrders === undefined) side.usedNewOrders = false;
}

// Draws one card, reshuffling the discard pile back into the deck first if
// it's run dry — same as a real card deck. With only 18 Secondary Missions
// total and up to 5 rounds of 2-a-turn draws plus New Orders/CP discards,
// running out during a long battle is the expected case, not an edge one.
// Returns null (never throws) if every mission is already active or
// completed on this side — nothing left to draw, not a bug.
function drawSecondaryCard(side, missionsData){
  if(side.secondaryDeckKeys.length === 0){
    if(side.secondaryDiscardKeys.length === 0) return null;
    side.secondaryDeckKeys = shuffled(side.secondaryDiscardKeys);
    side.secondaryDiscardKeys = [];
  }
  const key = side.secondaryDeckKeys.pop();
  const mission = missionsData.missions.find(m => normalizeMissionKey(m.displayName) === key);
  if(!mission) return null;
  const card = {
    id: uid('sec_'),
    key,
    displayName: mission.displayName,
    flavor: mission.flavor,
    intro: mission.intro,
    scoring: mission.scoring,
    action: mission.action,
  };
  side.secondaries.push(card);
  return card;
}

// Moves an active card to the discard pile (New Orders, the CP discard, or
// the once-per-draw WHEN DRAWN choice some cards offer) — available to be
// reshuffled back into the deck once it runs dry, same as a real discard
// pile, never permanently gone.
function discardSecondaryCard(side, secId){
  const card = (side.secondaries || []).find(s => s.id === secId);
  if(!card) return null;
  side.secondaries = side.secondaries.filter(s => s.id !== secId);
  side.secondaryDiscardKeys.push(card.key);
  return card;
}

// Moves an active card to the completed pile once its VP is banked — it's
// achieved, out of play for the rest of the battle (real rule: achieving a
// Tactical Secondary Mission discards it), so it comes off the active list
// entirely rather than staying there ticked. Keeps the full card (not just
// name/vp) so a completed card can still be reopened later — a mis-typed
// VP or an accidental achieve is easy to do mid-game, and there'd be no
// way to fix it otherwise.
function achieveSecondaryCard(side, secId, vp, turn){
  const card = (side.secondaries || []).find(s => s.id === secId);
  if(!card) return null;
  side.secondaries = side.secondaries.filter(s => s.id !== secId);
  side.completedSecondaries.push({ ...card, vp, turn });
  return card;
}

// Reverses achieveSecondaryCard — for an achieve that shouldn't have
// happened at all (tapped the wrong card, conditions weren't actually
// met), rather than just a wrong VP amount (see updateAchievedSecondaryVp).
function unachieveSecondaryCard(side, secId){
  const card = (side.completedSecondaries || []).find(s => s.id === secId);
  if(!card) return null;
  side.completedSecondaries = side.completedSecondaries.filter(s => s.id !== secId);
  const { vp, turn, ...restored } = card;
  side.secondaries.push(restored);
  return card;
}

// Corrects the banked VP on an already-achieved card without touching
// anything else about it (still completed, still discarded) — for a
// simple mis-typed amount.
function updateAchievedSecondaryVp(side, secId, vp){
  const card = (side.completedSecondaries || []).find(s => s.id === secId);
  if(!card) return null;
  card.vp = vp;
  return card;
}

// Shared by every tracker interaction (CP +/-, VP edit, add/toggle/remove
// a secondary, advance the turn, finish the game) — loads the battle,
// makes sure .tracker exists, hands it to the caller to mutate in place,
// then saves. Returns the updated battle so callers can re-render from it
// without a second read.
async function updateBattleTracker(battleId, mutateFn){
  const list = await loadBattles();
  const battle = list.find(b => b.id === battleId);
  if(!battle) return null;
  mutateFn(ensureTracker(battle));
  await saveBattlesList(list);
  return battle;
}

// Which Detachment card (by its roster-entry id) is the active one for a
// side that has more than one — see needsDispositionChoice/
// resolveActiveDetachment. Lives directly on the battle, same as
// opponent/date, since it's a property of that battle's roster rather
// than in-game tracker state.
async function updateBattleActiveDetachment(battleId, team, detachmentUnitId){
  const list = await loadBattles();
  const battle = list.find(b => b.id === battleId);
  if(!battle) return;
  if(team === 'my') battle.myActiveDetachmentId = detachmentUnitId;
  else battle.opponentActiveDetachmentId = detachmentUnitId;
  await saveBattlesList(list);
}

// ---------- COLLECTION (saved units, reusable across battles) ----------
// A datasheet saved here is a standalone copy, same pattern as a battle
// roster entry — reopening or adding it to a battle never needs another
// Gemini call, so the same physical miniature only ever gets scanned once.
async function addUnitToCollection(unit){
  const list = await loadCollection();
  const entry = Object.assign({}, unit, { id: uid('c_'), savedAt: Date.now() });
  list.unshift(entry);
  await saveCollectionList(list);
  return entry;
}

async function removeUnitFromCollection(unitId){
  const list = await loadCollection();
  await saveCollectionList(list.filter(u => u.id !== unitId));
}

// A text-list entry acts just like a unit entry in the collection UI — same
// card, and it can be added to a battle roster the same way — but it holds
// the raw pasted army-list text verbatim instead of a looked-up datasheet.
async function addTextListToCollection(rawText, label){
  const list = await loadCollection();
  const entry = { id: uid('c_'), savedAt: Date.now(), isTextList: true, listName: label || 'Imported List', rawText };
  list.unshift(entry);
  await saveCollectionList(list);
  return entry;
}

// A standalone Detachment Rules card saved from the search box (see
// findDetachmentByName / renderDetachmentSearchResult) — same "acts like a
// unit entry" pattern as the text-list entry above, but holds a detachment
// card instead of a datasheet or raw text.
async function addDetachmentToCollection(card){
  const list = await loadCollection();
  const entry = { id: uid('c_'), savedAt: Date.now(), isDetachment: true, card };
  list.unshift(entry);
  await saveCollectionList(list);
  return entry;
}

// Shared dedup-add used everywhere a unit/Detachment lands in a folder —
// list upload, the long-press "Move to..." below, and "Send to Army
// Folder" straight from a search result. Mutates folder in place; returns
// whether it actually added anything (false when that name was already
// there, same dedup rule the list-upload path itself uses).
function addUnitIntoFolder(folder, datasheet){
  folder.units = folder.units || [];
  const key = (datasheet.unit_name || '').toLowerCase();
  if(folder.units.some(u => (u.unit_name||'').toLowerCase() === key)) return false;
  folder.units.push(datasheet);
  return true;
}
function addDetachmentIntoFolder(folder, card){
  folder.detachmentCards = folder.detachmentCards || [];
  const key = normalizePointsName(card.displayName);
  if(folder.detachmentCards.some(c => normalizePointsName(c.displayName) === key)) return false;
  folder.detachmentCards.push(card);
  return true;
}

// Moves a standalone unit or Detachment card (long-pressed from the top
// level of My Collection — see renderMoveToFolderPicker) into an existing
// folder, then removes the standalone entry — the folder ends up holding
// it exactly as if it had been part of that list's original upload.
async function moveCollectionEntryToFolder(entry, folderId){
  const list = await loadCollection();
  const folder = list.find(f => f.id === folderId && f.isFolder);
  if(!folder) return;

  if(entry.isDetachment){
    addDetachmentIntoFolder(folder, entry.card);
  } else {
    const { id, savedAt, ...datasheet } = entry;
    addUnitIntoFolder(folder, datasheet);
  }

  await saveCollectionList(list.filter(x => x.id !== entry.id));
}

// Adds a unit/Detachment straight into an existing folder without it ever
// having been a standalone Collection entry — used by "Send to Army
// Folder" on a fresh search result, so saving to My Collection first
// isn't a required step.
async function sendUnitToFolder(datasheet, folderId){
  const list = await loadCollection();
  const folder = list.find(f => f.id === folderId && f.isFolder);
  if(!folder) return;
  addUnitIntoFolder(folder, datasheet);
  await saveCollectionList(list);
}
async function sendDetachmentToFolder(card, folderId){
  const list = await loadCollection();
  const folder = list.find(f => f.id === folderId && f.isFolder);
  if(!folder) return;
  addDetachmentIntoFolder(folder, card);
  await saveCollectionList(list);
}

// Generic "which Army List folder?" screen — reused by the long-press
// "Move to..." (moveCollectionEntryToFolder) and "Send to Army Folder" on
// a search result (sendUnitToFolder/sendDetachmentToFolder). Callers own
// what actually happens on pick/cancel; this only lists folders and wires
// the taps.
async function renderSendToFolderPicker(itemLabel, verb, onPick, onCancel){
  setStatus('', 'STANDBY');
  const list = await loadCollection();
  const folders = list.filter(f => f.isFolder);

  main.innerHTML = `
    <div class="noteBox">${verb} <strong>${escapeHtml(itemLabel)}</strong> into which Army List folder?</div>
    ${folders.length ? folders.map((f, i) => `
      <button class="btn gold" data-send-folder-idx="${i}" style="display:block; width:100%; margin-bottom:8px;">🗂 ${escapeHtml(f.folderName || 'Army List Units')}</button>
    `).join('') : '<div class="noteBox">No Army List folders yet — upload a list first to create one.</div>'}
    <button class="btn ghost" id="sendToCancelBtn" data-nav-back style="margin-top:6px;">✕ Cancel</button>
  `;
  folders.forEach((f, i) => {
    document.querySelector(`[data-send-folder-idx="${i}"]`).onclick = () => onPick(f);
  });
  document.getElementById('sendToCancelBtn').onclick = onCancel;
}

// "Move to..." screen shown on a long-press of a standalone unit or
// Detachment card in My Collection — lets it be folded into an existing
// Army List folder instead of staying its own top-level entry.
function renderMoveToFolderPicker(entry){
  const itemLabel = entry.isDetachment ? `${entry.card.displayName || 'Detachment'} Rules` : (entry.unit_name || 'Unknown Unit');
  renderSendToFolderPicker(itemLabel, 'Move', async (folder) => {
    await moveCollectionEntryToFolder(entry, folder.id);
    renderCollectionList();
  }, renderCollectionList);
}

// A folder holds full looked-up datasheets from one list upload, grouped
// together as one Collection entry — acts like a unit entry (same card,
// same picker row when adding to a battle), but selecting it in a battle
// expands into every unit it contains instead of adding just one.
async function addUnitsToCollectionFolder(datasheets, label, rawText, detachmentCards){
  const list = await loadCollection();
  const entry = { id: uid('c_'), savedAt: Date.now(), isFolder: true, folderName: label || 'Army List Units', units: datasheets, rawText: rawText || '', detachmentCards: detachmentCards || [] };
  list.unshift(entry);
  await saveCollectionList(list);
  return entry;
}

// ---------- SCREEN: BATTLE LIST ----------
async function renderBattleList(){
  clearFooter();
  setStatus('', 'STANDBY');
  currentBattleContext = null;
  renderLoading('OPENING ARCHIVE', 'Loading your battles…');

  const battles = await loadBattles();

  const emptyNote = `<div class="noteBox">No battles logged yet. Start one to track which units you and your opponent bring to the table, with one tap back to any datasheet.</div>`;
  const cards = battles.map(b => `
    <div class="libCard" data-id="${b.id}">
      <div class="libName">vs ${escapeHtml(b.opponent || 'Opponent')}</div>
      <div class="libMeta">${escapeHtml(formatBattleDate(b.date))} · ${b.myUnits.length} vs ${b.opponentUnits.length} units</div>
    </div>
  `).join('');

  main.innerHTML = `
    ${battles.length ? '<div class="noteBox">Tap a battle to open it.</div>' + cards : emptyNote}
    <button class="btn primary" id="newBattleBtn">+ New Battle</button>
    <button class="btn ghost" id="battlesHomeBtn" data-nav-back>🏠 Home</button>
  `;

  battles.forEach(b => {
    const card = main.querySelector(`.libCard[data-id="${b.id}"]`);
    if(card) card.addEventListener('click', () => renderBattleDetail(b.id));
  });

  document.getElementById('newBattleBtn').onclick = renderNewBattleForm;
  document.getElementById('battlesHomeBtn').onclick = renderHome;
}

// ---------- SCREEN: NEW BATTLE ----------
function renderNewBattleForm(){
  setStatus('', 'STANDBY');
  const today = new Date().toISOString().slice(0,10);
  main.innerHTML = `
    <div class="noteBox">Set up a new battle to track scans for both sides.</div>
    <input type="text" id="opponentInput" placeholder="Opponent's name" />
    <input type="date" id="dateInput" value="${today}" style="margin-top:8px;" />
    <button class="btn primary" id="startBattleBtn" style="margin-top:12px;">⚔️ Start Battle</button>
    <button class="btn ghost" id="cancelNewBattleBtn" data-nav-back>✕ Cancel</button>
  `;
  document.getElementById('startBattleBtn').onclick = async () => {
    const opponentInput = document.getElementById('opponentInput');
    const opponent = opponentInput.value.trim();
    if(!opponent){ opponentInput.focus(); return; }
    const date = document.getElementById('dateInput').value || today;
    const battle = await createBattle(opponent, date);
    renderBattleDetail(battle.id);
  };
  document.getElementById('cancelNewBattleBtn').onclick = renderBattleList;
}

// ---------- SCREEN: BATTLE DETAIL ----------
// A roster with more than one Detachment card needs the player to pick
// which one's Deposition actually applies for that battle (real 40k rule
// — an army built from two Detachments still only fields one Deposition).
// With 0 or 1 Detachment there's nothing ambiguous, so no choice is ever
// needed. activeId is ignored/moot in that case.
function needsDispositionChoice(units, activeId){
  const detachments = units.filter(u => u.isDetachment);
  if(detachments.length <= 1) return false;
  return !activeId || !detachments.some(d => d.id === activeId);
}
// The Detachment actually in effect: the only one if there's just one, the
// chosen one if there's a valid stored choice among several, otherwise
// null (ambiguous, unresolved).
function resolveActiveDetachment(units, activeId){
  const detachments = units.filter(u => u.isDetachment);
  if(detachments.length === 0) return null;
  if(detachments.length === 1) return detachments[0];
  return detachments.find(d => d.id === activeId) || null;
}

// Shared by renderBattleDetail and the Battle Tracker's My Army/Opponent's
// Army tabs — same roster cards, same remove button, in both places.
// activeDetachmentId marks which Detachment card (if this side has more
// than one) is the chosen one, so it's visibly distinguished on the card
// itself rather than the choice being invisible once made.
function buildTeamHtml(units, team, activeDetachmentId){
  if(!units.length) return `<div class="noteBox">No units scanned for this side yet.</div>`;
  // The army list's own text card always reads first, regardless of when
  // it was added relative to the units, with Detachment Rules cards
  // right after it — both are roster-level reference material, distinct
  // from the individual model units that make up the rest of the list
  // (in original order otherwise).
  const rank = (u) => u.isTextList ? 0 : u.isDetachment ? 1 : 2;
  const ordered = [...units].sort((a, b) => rank(a) - rank(b));
  const multipleDetachments = units.filter(u => u.isDetachment).length > 1;
  return ordered.map(u => {
    if(u.isTextList) return `
      <div class="libCard" data-unit="${u.id}" data-team="${team}">
        <div class="libName">📋 ${escapeHtml(u.listName || 'Imported List')}</div>
        <div class="libMeta">Text document</div>
        <button class="btn ghost" data-remove="${u.id}" data-remove-team="${team}" style="margin-top:8px;">🗑 Remove</button>
      </div>
    `;
    if(u.isDetachment){
      const activeBadge = !multipleDetachments ? '' : u.id === activeDetachmentId ? ' ✓ Active' : ' (not active)';
      return `
      <div class="libCard" data-unit="${u.id}" data-team="${team}">
        <div class="libName">📜 ${escapeHtml(u.card.displayName || 'Detachment')} Rules${activeBadge}</div>
        <div class="libMeta">${escapeHtml(u.card.faction||'')} · Detachment Rules</div>
        <button class="btn ghost" data-remove="${u.id}" data-remove-team="${team}" style="margin-top:8px;">🗑 Remove</button>
      </div>
    `;
    }
    return `
      <div class="libCard" data-unit="${u.id}" data-team="${team}">
        <div class="libName">${escapeHtml(u.unit_name||'Unknown Unit')}</div>
        <div class="libMeta">${escapeHtml(u.faction||'')}${u.points ? ' · '+escapeHtml(u.points) : ''}</div>
        <button class="btn ghost" data-remove="${u.id}" data-remove-team="${team}" style="margin-top:8px;">🗑 Remove</button>
      </div>
    `;
  }).join('');
}

// A roster card built by buildTeamHtml is either a real unit/text-list
// entry (renderBattleUnitView already handles both) or a Detachment Rules
// card, which needs the separate detachment-card viewer instead.
function renderRosterEntry(unit, battle, onBack, backLabel){
  if(unit.isDetachment){
    renderDetachmentRulesView(unit.card, onBack, backLabel);
  } else {
    renderBattleUnitView(battle, unit, onBack, backLabel);
  }
}

// Wires up the roster cards buildTeamHtml renders — tap to view a unit's
// datasheet (onUnitTap), tap Remove to pull it from the roster
// (re-rendering via onAfterRemove, since the two callers refresh
// different screens: the plain roster view refreshes itself, the Battle
// Tracker's army tab refreshes that same tab).
function wireTeamCards(battle, battleId, team, onUnitTap, onAfterRemove){
  const units = team === 'my' ? battle.myUnits : battle.opponentUnits;
  main.querySelectorAll(`[data-unit][data-team="${team}"]`).forEach(card => {
    card.addEventListener('click', (e) => {
      if(e.target.closest('[data-remove]')) return;
      const unit = units.find(u => u.id === card.getAttribute('data-unit'));
      if(unit) onUnitTap(unit);
    });
  });
  main.querySelectorAll(`[data-remove-team="${team}"]`).forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await removeUnitFromBattle(battleId, team, btn.getAttribute('data-remove'));
      onAfterRemove();
    });
  });
}

async function renderBattleDetail(battleId){
  clearFooter();
  setStatus('', 'STANDBY');
  currentBattleContext = null;
  renderLoading('OPENING ARCHIVE', 'Loading battle…');

  const battle = await getBattleById(battleId);
  if(!battle){ renderBattleList(); return; }
  const tracker = ensureTracker(battle); // in-memory default is fine here — only persisted once Start Battle is actually pressed

  const battleBtnLabel = tracker.finished ? '📊 View Battle Tracker'
    : tracker.started ? '⚔️ Continue Battle'
    : '⚔️ Start Battle';

  const needsChoice = needsDispositionChoice(battle.myUnits, battle.myActiveDetachmentId) || needsDispositionChoice(battle.opponentUnits, battle.opponentActiveDetachmentId);
  // Once there's more than one Detachment on a side, the button stays —
  // relabeled once resolved — so a wrong pick can still be corrected
  // later, not just made once and then hidden.
  const hasMultipleDetachments = battle.myUnits.filter(u => u.isDetachment).length > 1 || battle.opponentUnits.filter(u => u.isDetachment).length > 1;

  main.innerHTML = `
    <div class="noteBox">vs <strong>${escapeHtml(battle.opponent)}</strong> — ${escapeHtml(formatBattleDate(battle.date))}</div>
    <button class="btn primary" id="scanForBattleBtn">➕ Add Units</button>
    ${hasMultipleDetachments ? `<button class="btn gold" id="chooseDetachBtn" style="margin-top:6px;">${needsChoice ? '⚠️ Choose Active Detachment' : '🔀 Change Active Detachment'}</button>` : ''}
    <button class="btn gold" id="startBattleTrackerBtn" style="margin-top:6px;">${battleBtnLabel}</button>
    <button class="btn ghost" id="deleteBattleBtn" style="margin-top:6px;">🗑 Delete This Battle</button>
    <button class="btn ghost" id="battleDetailHomeBtn" style="margin-top:6px;">🏠 Home</button>
    <div class="sectionTitle" style="padding:0 2px; margin-top:8px;">My Army (${battle.myUnits.length})</div>
    ${buildTeamHtml(battle.myUnits, 'my', battle.myActiveDetachmentId)}
    ${battle.myUnits.length ? '<button class="btn ghost" id="shareMyQrBtn" style="margin-top:6px;">📤 Share My Army as QR</button>' : ''}
    <div class="sectionTitle" style="padding:0 2px; margin-top:8px;">${escapeHtml(battle.opponent)}'s Army (${battle.opponentUnits.length})</div>
    ${buildTeamHtml(battle.opponentUnits, 'opponent', battle.opponentActiveDetachmentId)}
    ${battle.opponentUnits.length ? `<button class="btn ghost" id="shareOppQrBtn" style="margin-top:6px;">📤 Share ${escapeHtml(battle.opponent)}'s Army as QR</button>` : ''}
    <button id="battleDetailBackTarget" data-nav-back style="display:none;"></button>
  `;

  wireTeamCards(battle, battleId, 'my', (unit) => renderRosterEntry(unit, battle, () => renderBattleDetail(battleId), '← Back to Battle'), () => renderBattleDetail(battleId));
  wireTeamCards(battle, battleId, 'opponent', (unit) => renderRosterEntry(unit, battle, () => renderBattleDetail(battleId), '← Back to Battle'), () => renderBattleDetail(battleId));

  document.getElementById('scanForBattleBtn').onclick = () => renderBattleScanChoice(battleId);
  if(document.getElementById('chooseDetachBtn')) document.getElementById('chooseDetachBtn').onclick = () => renderChooseActiveDetachment(battleId);
  document.getElementById('startBattleTrackerBtn').onclick = async () => {
    // A side with more than one Detachment needs the player to pick which
    // one's Deposition actually applies before play begins — a real 40k
    // rule, not something to silently guess at.
    const fresh = await getBattleById(battleId);
    if(needsDispositionChoice(fresh.myUnits, fresh.myActiveDetachmentId) || needsDispositionChoice(fresh.opponentUnits, fresh.opponentActiveDetachmentId)){
      renderChooseActiveDetachment(battleId);
      return;
    }
    if(!tracker.started){
      await updateBattleTracker(battleId, t => { t.started = true; });
    }
    renderBattleTracker(battleId, 'tracker');
  };
  document.getElementById('deleteBattleBtn').onclick = () => renderDeleteBattleConfirm(battle);
  document.getElementById('battleDetailHomeBtn').onclick = renderHome;
  // The visible footer button intentionally jumps straight Home (a
  // deliberate shortcut) — the global "✕" instead steps back exactly one
  // level, to the Battles list, via this hidden marker.
  document.getElementById('battleDetailBackTarget').onclick = renderBattleList;
  if(document.getElementById('shareMyQrBtn')) document.getElementById('shareMyQrBtn').onclick = () => renderShareRosterQr(battleId, 'my');
  if(document.getElementById('shareOppQrBtn')) document.getElementById('shareOppQrBtn').onclick = () => renderShareRosterQr(battleId, 'opponent');
}

// Shown either voluntarily (the "⚠️ Choose Active Detachment" button on
// Battle Detail, whenever a side has more than one) or forced on tapping
// Start Battle if it's still unresolved — either way, tapping an option
// picks it immediately and re-renders this same screen so the choice is
// visible right away; Continue only actually proceeds once every side
// that needs one has a valid choice made.
async function renderChooseActiveDetachment(battleId, onDone){
  onDone = onDone || (() => renderBattleDetail(battleId));
  setStatus('', 'STANDBY');
  const battle = await getBattleById(battleId);
  if(!battle){ renderBattleList(); return; }
  for(const u of [...battle.myUnits, ...battle.opponentUnits]){
    if(u.isDetachment) u.card = await withFreshDisposition(u.card);
  }

  const buildSideChoice = (units, team, label, activeId) => {
    const detachments = units.filter(u => u.isDetachment);
    if(detachments.length <= 1) return '';
    return `
      <div class="sectionTitle" style="padding:0 2px; margin-top:8px;">${escapeHtml(label)}</div>
      ${detachments.map(d => `
        <button class="btn ${d.id === activeId ? 'primary' : 'ghost'}" data-choose-detach="${d.id}" data-choose-team="${team}" style="display:block; width:100%; text-align:left; margin-bottom:8px;">
          ${d.id === activeId ? '✓ ' : ''}${escapeHtml(d.card.displayName || 'Detachment')} — ${escapeHtml(d.card.disposition || 'No Deposition')}
        </button>
      `).join('')}
    `;
  };

  const myHtml = buildSideChoice(battle.myUnits, 'my', 'My Army', battle.myActiveDetachmentId);
  const oppHtml = buildSideChoice(battle.opponentUnits, 'opponent', `${battle.opponent}'s Army`, battle.opponentActiveDetachmentId);

  main.innerHTML = `
    <div class="noteBox">More than one Detachment was found. An army only fields one Deposition at a time — pick which Detachment's applies for this battle.</div>
    ${myHtml}
    ${oppHtml}
    <button class="btn primary" id="confirmDetachChoiceBtn" style="margin-top:14px;">✓ Continue</button>
    <button class="btn ghost" id="cancelDetachChoiceBtn" data-nav-back>← Back to Battle</button>
  `;

  main.querySelectorAll('[data-choose-detach]').forEach(btn => {
    btn.onclick = async () => {
      await updateBattleActiveDetachment(battleId, btn.getAttribute('data-choose-team'), btn.getAttribute('data-choose-detach'));
      renderChooseActiveDetachment(battleId, onDone);
    };
  });

  document.getElementById('confirmDetachChoiceBtn').onclick = async () => {
    const fresh = await getBattleById(battleId);
    const stillNeeded = needsDispositionChoice(fresh.myUnits, fresh.myActiveDetachmentId) || needsDispositionChoice(fresh.opponentUnits, fresh.opponentActiveDetachmentId);
    if(stillNeeded){
      main.insertAdjacentHTML('afterbegin', '<div class="noteBox" style="border-color:var(--blood-bright); color:var(--parchment);">Pick one Detachment for each army listed above before continuing.</div>');
      return;
    }
    onDone();
  };
  document.getElementById('cancelDetachChoiceBtn').onclick = onDone;
}

function renderDeleteBattleConfirm(battle){
  main.innerHTML = `
    <div class="errBox">
      <div class="errTitle">Delete This Battle?</div>
      This permanently deletes the battle vs ${escapeHtml(battle.opponent)} and all ${battle.myUnits.length + battle.opponentUnits.length} logged units. This can't be undone.
    </div>
    <button class="btn primary" id="confirmDeleteBattleBtn" style="margin-top:14px;">🗑 Yes, Delete It</button>
    <button class="btn ghost" id="cancelDeleteBattleBtn" data-nav-back>← Cancel</button>
  `;
  document.getElementById('confirmDeleteBattleBtn').onclick = async () => {
    await deleteBattle(battle.id);
    renderBattleList();
  };
  document.getElementById('cancelDeleteBattleBtn').onclick = () => renderBattleDetail(battle.id);
}

// ---------- SCREEN: BATTLE — WHO IS THIS SCAN FOR ----------
async function renderBattleScanChoice(battleId){
  setStatus('', 'STANDBY');
  const battle = await getBattleById(battleId);
  if(!battle){ renderBattleList(); return; }
  main.innerHTML = `
    <div class="noteBox">Who is this scan for?</div>
    <button class="btn primary" id="forMeBtn">🙋 My Army</button>
    <button class="btn gold" id="forOpponentBtn">⚔️ ${escapeHtml(battle.opponent)}'s Army</button>
    <button class="btn ghost" id="cancelScanChoiceBtn" data-nav-back>← Cancel</button>
  `;
  document.getElementById('forMeBtn').onclick = () => {
    currentBattleContext = { battleId, team:'my' };
    renderBattleScanEntry(battleId, 'my');
  };
  document.getElementById('forOpponentBtn').onclick = () => {
    currentBattleContext = { battleId, team:'opponent' };
    renderBattleScanEntry(battleId, 'opponent');
  };
  document.getElementById('cancelScanChoiceBtn').onclick = () => renderBattleDetail(battleId);
}

// ---------- SCREEN: BATTLE SCAN ENTRY (camera/upload/search, battle-tagged) ----------
async function renderBattleScanEntry(battleId, team){
  clearFooter();
  setStatus('', 'STANDBY');
  onPhotoReady = identifyFromImage;
  onCameraCancel = () => renderBattleScanEntry(battleId, team);

  const battle = await getBattleById(battleId);
  if(!battle){ renderBattleList(); return; }
  const teamLabel = team === 'my' ? 'My Army' : `${battle.opponent}'s Army`;

  main.innerHTML = `
    <div class="noteBox">Scanning for: <strong>${escapeHtml(teamLabel)}</strong></div>
    <button class="btn primary" id="battleScanBtn">📷 Scan Miniature</button>
    <button class="btn gold" id="battleUploadBtn">🖼 Upload a Photo</button>
    <input type="file" id="battleFileInput" accept="image/*" style="display:none;" />
    <div class="divider">or</div>
    <input type="text" id="battleManualInput" placeholder="Type a unit name, e.g. Intercessors" />
    <button class="btn gold" id="battleManualBtn">🔎 Look Up Datasheet</button>
    <button class="btn ghost" id="battleFromCollectionBtn" style="margin-top:10px;">📚 Add From My Collection</button>
    <button class="btn ghost" id="battleImportQrBtn">🔳 Import Roster via QR</button>
    <button class="btn ghost" id="battleScanCancelBtn" data-nav-back style="margin-top:10px;">← Back to Battle</button>
  `;
  document.getElementById('battleScanBtn').onclick = openCamera;
  document.getElementById('battleUploadBtn').onclick = () => {
    document.getElementById('battleFileInput').click();
  };
  document.getElementById('battleFileInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = () => identifyFromImage(reader.result);
    reader.onerror = () => renderIdError({message:'Could not read that file'}, null);
    reader.readAsDataURL(file);
  });
  document.getElementById('battleManualBtn').onclick = () => {
    const v = document.getElementById('battleManualInput').value.trim();
    if(v) fetchDatasheet(v, '', 'direct');
  };
  document.getElementById('battleManualInput').addEventListener('keydown', e=>{
    if(e.key==='Enter'){ document.getElementById('battleManualBtn').click(); }
  });
  document.getElementById('battleFromCollectionBtn').onclick = () => renderBattleCollectionPicker(battleId, team);
  document.getElementById('battleImportQrBtn').onclick = () => renderImportQrScan(battleId, team);
  document.getElementById('battleScanCancelBtn').onclick = () => {
    currentBattleContext = null;
    renderBattleDetail(battleId);
  };
}

// ---------- SCREEN: BATTLE — ADD FROM SAVED COLLECTION (no rescanning) ----------
async function renderBattleCollectionPicker(battleId, team){
  setStatus('', 'STANDBY');
  const [battle, list] = await Promise.all([getBattleById(battleId), loadCollection()]);
  if(!battle){ renderBattleList(); return; }
  const teamLabel = team === 'my' ? 'My Army' : `${battle.opponent}'s Army`;

  const emptyNote = `<div class="noteBox">Your collection is empty. Open any datasheet and tap "Save to My Collection" first, then it'll show up here for future battles.</div>`;
  const rows = list.map((u, i) => {
    if(u.isFolder) return `
      <label class="libCard" style="display:flex; align-items:center; gap:10px; cursor:pointer;">
        <input type="checkbox" class="collPickCheck" data-idx="${i}" style="width:18px; height:18px; flex-shrink:0;"/>
        <span style="flex:1;">
          <div class="libName" style="margin:0;">🗂 ${escapeHtml(u.folderName || 'Army List Units')}</div>
          <div class="libMeta">${u.units.length} unit${u.units.length===1?'':'s'} — adds them all</div>
        </span>
      </label>
    `;
    if(u.isTextList) return `
      <label class="libCard" style="display:flex; align-items:center; gap:10px; cursor:pointer;">
        <input type="checkbox" class="collPickCheck" data-idx="${i}" style="width:18px; height:18px; flex-shrink:0;"/>
        <span style="flex:1;">
          <div class="libName" style="margin:0;">📋 ${escapeHtml(u.listName || 'Imported List')}</div>
          <div class="libMeta">Text document</div>
        </span>
      </label>
    `;
    if(u.isDetachment) return `
      <label class="libCard" style="display:flex; align-items:center; gap:10px; cursor:pointer;">
        <input type="checkbox" class="collPickCheck" data-idx="${i}" style="width:18px; height:18px; flex-shrink:0;"/>
        <span style="flex:1;">
          <div class="libName" style="margin:0;">📜 ${escapeHtml(u.card.displayName || 'Detachment')} Rules</div>
          <div class="libMeta">${escapeHtml(u.card.faction || '')}${u.card.disposition ? ' · ' + escapeHtml(u.card.disposition) : ''}</div>
        </span>
      </label>
    `;
    return `
      <label class="libCard" style="display:flex; align-items:center; gap:10px; cursor:pointer;">
        <input type="checkbox" class="collPickCheck" data-idx="${i}" style="width:18px; height:18px; flex-shrink:0;"/>
        <span style="flex:1;">
          <div class="libName" style="margin:0;">${escapeHtml(u.unit_name||'Unknown Unit')}</div>
          <div class="libMeta">${escapeHtml(u.faction||'')}${u.points ? ' · '+escapeHtml(u.points) : ''}</div>
        </span>
      </label>
    `;
  }).join('');

  main.innerHTML = `
    <div class="noteBox">Adding to: <strong>${escapeHtml(teamLabel)}</strong>. Select any saved units, folders, or lists to add — no rescanning needed.</div>
    ${list.length ? rows : emptyNote}
    ${list.length ? '<button class="btn primary" id="confirmCollAddBtn" style="margin-top:14px;">✓ Add Selected</button>' : ''}
    <button class="btn ghost" id="collPickerBackBtn" data-nav-back style="margin-top:10px;">← Back</button>
  `;

  if(list.length){
    document.getElementById('confirmCollAddBtn').onclick = async () => {
      const selected = list.filter((u, i) => document.querySelector(`.collPickCheck[data-idx="${i}"]`).checked);
      if(!selected.length) return;
      for(const u of selected){
        if(u.isFolder){
          for(const sub of u.units){ await addUnitToBattle(battleId, team, sub); }
          // The folder's own list text comes along too, as its own card in
          // the roster — otherwise there'd be no way to look at the full
          // list again once its units are split out into the battle.
          if(u.rawText){
            await addUnitToBattle(battleId, team, { isTextList: true, listName: u.folderName, rawText: u.rawText });
          }
          // Detachment Rules cards come along too, each as its own roster
          // entry separate from both the list-text card and the units —
          // otherwise they'd be silently dropped the moment a folder's
          // units get split out into a battle.
          for(const card of (u.detachmentCards || [])){
            await addUnitToBattle(battleId, team, { isDetachment: true, card });
          }
        } else {
          await addUnitToBattle(battleId, team, u);
        }
      }
      // Reaching this screen via the Battle Tracker's own "Add Units" (see
      // renderBattleTracker) sets returnToTracker so finishing here goes
      // back to that same tab, not the plain roster screen — same as the
      // scan/search "add to battle" path already does.
      const ctx = currentBattleContext;
      currentBattleContext = null;
      if(ctx && ctx.returnToTracker) renderBattleTracker(battleId, team);
      else renderBattleDetail(battleId);
    };
  }
  document.getElementById('collPickerBackBtn').onclick = () => renderBattleScanEntry(battleId, team);
}

// ---------- ROSTER SHARING VIA QR CODE ----------
// The QR payload only carries unit name + faction, not full datasheets —
// a QR code has a hard capacity limit (a few KB at most), and a battle's
// worth of full stat blocks/abilities text can easily exceed that, while
// a name+faction pair per unit stays tiny even for a large army. The
// importing side re-looks up each unit (same as typing it into Search by
// Name), so this trades a few automatic Gemini calls for never being able
// to fail on QR size or on stale embedded stats.
async function renderShareRosterQr(battleId, team){
  setStatus('', 'STANDBY');
  const battle = await getBattleById(battleId);
  if(!battle){ renderBattleList(); return; }
  // The QR payload is a name+faction pair per unit, re-looked-up on
  // import — text-list and Detachment Rules entries have neither, so
  // they're excluded the same way (they'd otherwise show up as blank
  // {n: undefined} junk in the payload).
  const units = (team === 'my' ? battle.myUnits : battle.opponentUnits).filter(u => !u.isTextList && !u.isDetachment);
  const teamLabel = team === 'my' ? 'My Army' : `${battle.opponent}'s Army`;

  const payload = JSON.stringify({ v: 1, u: units.map(u => ({ n: u.unit_name, f: u.faction || '' })) });

  let qrDataUrl;
  try{
    qrDataUrl = await QRCode.toDataURL(payload, { errorCorrectionLevel: 'L', margin: 1, width: 280 });
  }catch(err){
    main.innerHTML = `
      <div class="errBox">
        <div class="errTitle">Couldn't Generate QR Code</div>
        ${escapeHtml(err.message || 'This roster may be too large for a single QR code.')}
      </div>
      <button class="btn ghost" id="qrGenBackBtn" data-nav-back style="margin-top:14px;">← Back</button>
    `;
    document.getElementById('qrGenBackBtn').onclick = () => renderBattleDetail(battleId);
    return;
  }

  main.innerHTML = `
    <div class="noteBox">Have your opponent open <strong>Battles → Add Units → Import Roster via QR</strong> and point their camera at this code to pull in ${units.length} unit${units.length===1?'':'s'} from <strong>${escapeHtml(teamLabel)}</strong> — no rescanning needed on their end. Each unit gets freshly looked up on import, same as searching it by name.</div>
    <div style="display:flex; justify-content:center; padding:16px 0;">
      <img src="${qrDataUrl}" alt="Roster QR code" style="width:100%; max-width:280px; border-radius:4px;"/>
    </div>
    <button class="btn ghost" id="qrDoneBtn" data-nav-back>← Back to Battle</button>
  `;
  document.getElementById('qrDoneBtn').onclick = () => renderBattleDetail(battleId);
}

let qrScanRAF = null;
let qrScanStream = null;

function stopQrScan(){
  if(qrScanRAF){ cancelAnimationFrame(qrScanRAF); qrScanRAF = null; }
  if(qrScanStream){ qrScanStream.getTracks().forEach(t=>t.stop()); qrScanStream = null; }
}

// ---------- SCREEN: BATTLE — IMPORT ROSTER VIA QR (camera scan) ----------
async function renderImportQrScan(battleId, team){
  clearFooter();
  setStatus('', 'STANDBY');
  stopQrScan();

  const battle = await getBattleById(battleId);
  if(!battle){ renderBattleList(); return; }

  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    main.innerHTML = `
      <div class="errBox">
        <div class="errTitle">Camera Not Available Here</div>
        QR import needs camera access, which isn't available in this browser/environment.
      </div>
      <button class="btn ghost" id="qrScanBackBtn" data-nav-back>← Back</button>
    `;
    document.getElementById('qrScanBackBtn').onclick = () => renderBattleScanEntry(battleId, team);
    return;
  }

  main.innerHTML = `
    <div class="noteBox">Point your camera at your opponent's roster QR code.</div>
    <div id="camWrap">
      <video id="qrVideo" autoplay playsinline muted></video>
      <div class="reticle">
        <div class="corner tl"></div><div class="corner tr"></div>
        <div class="corner bl"></div><div class="corner br"></div>
      </div>
    </div>
    <canvas id="qrCanvas" style="display:none;"></canvas>
    <button class="btn ghost" id="qrScanCancelBtn" data-nav-back style="margin-top:14px;">← Cancel</button>
  `;
  document.getElementById('qrScanCancelBtn').onclick = () => { stopQrScan(); renderBattleScanEntry(battleId, team); };

  try{
    qrScanStream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:'environment' }, audio:false });
  }catch(err){
    main.innerHTML = `
      <div class="errBox">
        <div class="errTitle">Camera Access Failed</div>
        ${escapeHtml(err.message || 'Could not access the camera.')}
      </div>
      <button class="btn ghost" id="qrScanBackBtn2" data-nav-back style="margin-top:14px;">← Back</button>
    `;
    document.getElementById('qrScanBackBtn2').onclick = () => renderBattleScanEntry(battleId, team);
    return;
  }

  const video = document.getElementById('qrVideo');
  video.srcObject = qrScanStream;
  const canvas = document.getElementById('qrCanvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const scanFrame = () => {
    if(video.readyState === video.HAVE_ENOUGH_DATA){
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      let imageData = null;
      try{ imageData = ctx.getImageData(0, 0, canvas.width, canvas.height); }catch(e){ /* frame not ready */ }
      if(imageData){
        const code = jsQR(imageData.data, imageData.width, imageData.height);
        if(code && code.data){
          stopQrScan();
          handleScannedRosterPayload(battleId, team, code.data);
          return;
        }
      }
    }
    qrScanRAF = requestAnimationFrame(scanFrame);
  };
  qrScanRAF = requestAnimationFrame(scanFrame);
}

function handleScannedRosterPayload(battleId, team, raw){
  let parsed = null;
  try{ parsed = JSON.parse(raw); }catch(e){ /* not JSON */ }
  if(!parsed || !Array.isArray(parsed.u) || !parsed.u.length){
    main.innerHTML = `
      <div class="errBox">
        <div class="errTitle">Not a WarCamera Roster Code</div>
        That QR code doesn't look like a WarCamera 4k roster export.
      </div>
      <button class="btn primary" id="qrRetryBtn" style="margin-top:14px;">↺ Try Again</button>
      <button class="btn ghost" id="qrCancelBtn2" data-nav-back>← Cancel</button>
    `;
    document.getElementById('qrRetryBtn').onclick = () => renderImportQrScan(battleId, team);
    document.getElementById('qrCancelBtn2').onclick = () => renderBattleScanEntry(battleId, team);
    return;
  }
  renderImportConfirm(battleId, team, parsed.u);
}

async function renderImportConfirm(battleId, team, units){
  setStatus('', 'STANDBY');
  const battle = await getBattleById(battleId);
  if(!battle){ renderBattleList(); return; }
  const teamLabel = team === 'my' ? 'My Army' : `${battle.opponent}'s Army`;

  const cards = units.map(u => `
    <div class="libCard">
      <div class="libName">${escapeHtml(u.n || 'Unknown Unit')}</div>
      ${u.f ? `<div class="libMeta">${escapeHtml(u.f)}</div>` : ''}
    </div>
  `).join('');

  main.innerHTML = `
    <div class="noteBox">Found ${units.length} unit${units.length===1?'':'s'}. Import into <strong>${escapeHtml(teamLabel)}</strong>? Each one gets freshly looked up, same as a name search.</div>
    ${cards}
    <button class="btn primary" id="confirmImportBtn" style="margin-top:14px;">✓ Import ${units.length} Unit${units.length===1?'':'s'}</button>
    <button class="btn ghost" id="cancelImportBtn" data-nav-back>✕ Cancel</button>
  `;
  document.getElementById('confirmImportBtn').onclick = () => runRosterImport(battleId, team, units);
  document.getElementById('cancelImportBtn').onclick = () => renderBattleScanEntry(battleId, team);
}

async function runRosterImport(battleId, team, units){
  setStatus('busy', 'IMPORTING');
  let succeeded = 0;
  const failed = [];
  for(let i=0;i<units.length;i++){
    renderLoading('IMPORTING ROSTER', `Looking up ${i+1} of ${units.length}: ${units[i].n}…`);
    try{
      const d = await lookupDatasheetRaw(units[i].n, units[i].f || '', false);
      await addUnitToBattle(battleId, team, d);
      succeeded++;
    }catch(err){
      failed.push(units[i].n);
    }
  }
  setStatus('', 'LINK ESTABLISHED');
  renderImportSummary(battleId, succeeded, failed);
}

function renderImportSummary(battleId, succeeded, failed){
  main.innerHTML = `
    <div class="noteBox">Imported ${succeeded} unit${succeeded===1?'':'s'} into the battle.${failed.length ? ' Couldn\'t confidently look up: '+failed.map(n=>escapeHtml(n)).join(', ')+' — try adding those individually.' : ''}</div>
    <button class="btn primary" id="importDoneBtn" data-nav-back>⚔️ View Battle</button>
  `;
  document.getElementById('importDoneBtn').onclick = () => renderBattleDetail(battleId);
}

// ---------- SCREEN: BATTLE — VIEW A SAVED UNIT (read-only) ----------
// onBack/backLabel default to returning to the plain roster screen (the
// only caller before the Battle Tracker existed) — the tracker's army
// tabs pass their own, so tapping a unit from there returns to that same
// tab instead of dropping out of the tracker.
function renderBattleUnitView(battle, unit, onBack, backLabel){
  onBack = onBack || (() => renderBattleDetail(battle.id));
  backLabel = backLabel || '← Back to Battle';
  setStatus('', 'STANDBY');
  if(unit.isTextList){
    renderTextListView(unit, onBack, backLabel);
    return;
  }
  main.innerHTML = buildDatasheetSheetHtml(unit);
  footer.style.display = 'flex';
  footer.innerHTML = `<button class="btn ghost" id="unitBackBtn" data-nav-back>${escapeHtml(backLabel)}</button>`;
  document.getElementById('unitBackBtn').onclick = onBack;
}

// ---------- SCREEN: BATTLE TRACKER (live in-game VP/CP/secondaries/turn) ----------
const TOTAL_TURNS = 5;

function buildSideTrackerHtml(side, team, label, turn){
  const secondaries = side.secondaries || [];
  const secHtml = secondaries.map(s => `
    <div class="secItem" data-sec-id="${s.id}" data-sec-team="${team}">
      <span class="secName">📋 ${escapeHtml(s.displayName)}</span>
      <span class="secMenuHint">⋮</span>
    </div>
  `).join('') || `<div class="loadSub">No active secondaries — draw 2 to start.</div>`;

  const completed = side.completedSecondaries || [];
  const completedHtml = completed.length ? `
    <div class="secListLabel" style="margin-top:10px;">Achieved (tap to review or fix)</div>
    ${completed.map(c => `
      <div class="secItem secItemDone" data-sec-id="${c.id}" data-sec-team="${team}" data-sec-completed="1">
        <span class="secName scored">✓ ${escapeHtml(c.displayName)}</span>
        <span class="secPts">${c.vp || 0} VP</span>
      </div>
    `).join('')}
  ` : '';

  const alreadyDrawn = side.secondaryLastDrawnTurn === turn;
  const deckExhausted = (side.secondaryDeckKeys || []).length === 0 && (side.secondaryDiscardKeys || []).length === 0;

  return `
    <div class="trackerSide">
      <div class="sectionTitle">${escapeHtml(label)}</div>
      <div class="counterRow">
        <span class="counterLabel">CP</span>
        <button class="counterBtn" data-cp-team="${team}" data-cp-delta="-1">−</button>
        <span class="counterVal" id="cpVal-${team}">${side.cp}</span>
        <button class="counterBtn" data-cp-team="${team}" data-cp-delta="1">+</button>
      </div>
      <div class="counterRow">
        <span class="counterLabel">Primary VP</span>
        <input type="number" class="vpInput" data-vp-team="${team}" min="0" value="${side.primaryVP}"/>
      </div>
      <div class="secListLabel">Secondary Missions (tap to view, hold for options)</div>
      ${secHtml}
      ${completedHtml}
      <button class="btn ${alreadyDrawn ? 'ghost' : 'gold'}" data-draw-team="${team}" style="margin-top:10px;" ${alreadyDrawn || deckExhausted ? 'disabled' : ''}>${alreadyDrawn ? '✓ Drawn This Turn' : deckExhausted ? 'No Missions Left to Draw' : '🎲 Draw 2 Secondary Missions'}</button>
    </div>
  `;
}

function buildTrackerTabHtml(battle, tracker){
  if(tracker.finished){
    const myTotal = totalVP(tracker.my), oppTotal = totalVP(tracker.opponent);
    const verdict = myTotal === oppTotal ? 'Tied Game' : myTotal > oppTotal ? '🏆 You Win!' : `🏆 ${escapeHtml(battle.opponent)} Wins`;
    return `
      <div class="noteBox" style="text-align:center; font-size:14px; letter-spacing:2px; color:var(--brass); text-transform:uppercase; border:none;">Game Complete</div>
      <div class="vpBoard"><div class="vpSide"><div class="vpLabel">My Army</div><div class="vpTotal">${myTotal}</div></div><div class="vpVs">VS</div><div class="vpSide"><div class="vpLabel">${escapeHtml(battle.opponent)}</div><div class="vpTotal">${oppTotal}</div></div></div>
      <div class="noteBox" style="text-align:center; font-size:16px; color:var(--parchment); border:none;">${verdict}</div>
      ${buildSideTrackerReadOnlyHtml(tracker.my, 'My Army')}
      ${buildSideTrackerReadOnlyHtml(tracker.opponent, battle.opponent)}
    `;
  }
  return `
    <div class="vpBoard">
      <div class="vpSide"><div class="vpLabel">My Army</div><div class="vpTotal">${totalVP(tracker.my)}</div></div>
      <div class="vpVs">VS</div>
      <div class="vpSide"><div class="vpLabel">${escapeHtml(battle.opponent)}</div><div class="vpTotal">${totalVP(tracker.opponent)}</div></div>
    </div>
    <div class="turnBadge">Turn ${tracker.turn}</div>
    <button class="btn gold" id="primaryMissionBtn" style="margin-bottom:14px;">🎯 Primary Mission</button>
    ${buildSideTrackerHtml(tracker.my, 'my', 'My Army', tracker.turn)}
    ${buildSideTrackerHtml(tracker.opponent, 'opponent', `${battle.opponent}'s Army`, tracker.turn)}
    <button class="btn primary" id="finishTurnBtn" style="margin-top:14px;">${tracker.turn >= TOTAL_TURNS ? '🏁 Finish Game' : '➡ Finish Turn'}</button>
    ${tracker.turn > 1 ? '<button class="btn ghost" id="prevTurnBtn" style="margin-top:8px; font-size:11px; padding:12px 18px;">⬅ Previous Turn</button>' : ''}
  `;
}

function buildSideTrackerReadOnlyHtml(side, label){
  const completed = side.completedSecondaries || [];
  const secHtml = completed.map(c => `<div class="secItem"><span class="secName scored">${escapeHtml(c.displayName)}</span><span class="secPts">${c.vp || 0} VP</span></div>`).join('') || `<div class="loadSub">No secondaries achieved.</div>`;
  return `
    <div class="trackerSide">
      <div class="sectionTitle">${escapeHtml(label)} — Final</div>
      <div class="counterRow"><span class="counterLabel">CP Remaining</span><span class="counterVal">${side.cp}</span></div>
      <div class="counterRow"><span class="counterLabel">Primary VP</span><span class="counterVal">${side.primaryVP || 0}</span></div>
      <div class="secListLabel">Secondaries Achieved</div>
      ${secHtml}
    </div>
  `;
}

// Same scoring-block rendering as buildPrimaryMissionSideHtml (header, WHEN,
// each entry's VP), but a Secondary Mission card has no per-turn "this is
// the active one" concept to highlight — every block is just shown as
// written — and entries can lead with "OR" (alternative condition) instead
// of "+" (additive), and carry a VP cap ("(UP TO 5VP)") alongside plain
// VP values. Also shown here: the optional WHEN-DRAWN/explanatory intro
// text, and the nested Objective Action a handful of cards define.
function buildSecondaryScoringHtml(card){
  const blocksHtml = (card.scoring || []).map(block => `
    <div class="missionBlock">
      <div class="missionBlockHdr">${escapeHtml(block.header)}</div>
      ${block.when ? `<div class="missionBlockWhen">WHEN: ${escapeHtml(block.when)}</div>` : ''}
      ${block.entries.map(e => `
        <div class="missionEntry">
          <span>${e.or ? 'OR ' : e.plus ? '+ ' : ''}${escapeHtml(e.text)}</span>
          <span class="missionVP">${escapeHtml(e.vp)}${e.cap ? ' ' + escapeHtml(e.cap) : ''}</span>
        </div>
      `).join('')}
    </div>
  `).join('');
  const actionHtml = card.action ? `
    <div class="missionAction">
      <div class="missionActionName">🎯 ${escapeHtml(card.action.displayName)} (Objective Action)</div>
      ${card.action.rows.map(r => `<div class="missionActionRow"><b>${escapeHtml(r.label)}:</b> ${escapeHtml(r.text)}</div>`).join('')}
    </div>
  ` : '';
  return `
    <div class="missionSide">
      <div class="missionSideHead">
        <div class="missionName">${escapeHtml(card.displayName)}</div>
        <div class="missionFlavor">${escapeHtml(card.flavor)}</div>
        ${card.intro ? `<div class="missionFlavor" style="font-style:normal; margin-top:8px;">${escapeHtml(card.intro)}</div>` : ''}
      </div>
      ${blocksHtml}
      ${actionHtml}
    </div>
  `;
}

// Reached by tapping a Secondary Mission card, active or already achieved
// — an achieved card isn't locked, since a mis-typed VP or an accidental
// achieve is easy to do mid-game and there'd otherwise be no way to fix
// it. Shows the card's full text either way, and lets the player bank (or
// re-bank) VP for it once they've read the conditions and decided they met
// them — same "player reads the card, types in what they scored" pattern
// already used for Primary VP, since the app has no way to know what
// happened on the table.
async function renderSecondaryMissionCard(battleId, team, secId, returnTab){
  setStatus('', 'STANDBY');
  const battle = await getBattleById(battleId);
  if(!battle){ renderBattleList(); return; }
  const tracker = ensureTracker(battle);
  const side = team === 'my' ? tracker.my : tracker.opponent;
  const activeCard = (side.secondaries || []).find(s => s.id === secId);
  const completedCard = (side.completedSecondaries || []).find(s => s.id === secId);
  let card = activeCard || completedCard;
  if(!card){ renderBattleTracker(battleId, returnTab || 'tracker'); return; }
  const isCompleted = !activeCard;
  card = await withFreshSecondaryData(card);

  main.innerHTML = `
    ${buildSecondaryScoringHtml(card)}
    <div class="counterRow" style="margin-top:14px;">
      <span class="counterLabel">VP Scored</span>
      <input type="number" id="secAchieveVpInput" min="0" class="vpInput" style="max-width:100px;" value="${isCompleted ? (completedCard.vp || 0) : 0}"/>
    </div>
    <button class="btn primary" id="secAchieveBtn" style="margin-top:10px;">${isCompleted ? '✓ Update VP' : '✓ Mark Achieved'}</button>
    ${isCompleted ? '<button class="btn ghost" id="secUnachieveBtn" style="margin-top:8px;">↩ Un-Achieve (Move Back to Active)</button>' : ''}
  `;
  footer.style.display = 'flex';
  footer.innerHTML = `<button class="btn ghost" id="secCardBackBtn" data-nav-back>← Back to Tracker</button>`;
  document.getElementById('secCardBackBtn').onclick = () => renderBattleTracker(battleId, returnTab || 'tracker');
  document.getElementById('secAchieveBtn').onclick = async () => {
    const vp = Math.max(0, parseInt(document.getElementById('secAchieveVpInput').value, 10) || 0);
    await updateBattleTracker(battleId, t => {
      const s = team === 'my' ? t.my : t.opponent;
      if(isCompleted) updateAchievedSecondaryVp(s, secId, vp);
      else achieveSecondaryCard(s, secId, vp, t.turn);
    });
    renderBattleTracker(battleId, returnTab || 'tracker');
  };
  if(document.getElementById('secUnachieveBtn')){
    document.getElementById('secUnachieveBtn').onclick = async () => {
      await updateBattleTracker(battleId, t => {
        unachieveSecondaryCard(team === 'my' ? t.my : t.opponent, secId);
      });
      renderBattleTracker(battleId, returnTab || 'tracker');
    };
  }
}

// A handful of Secondary Missions carry their own discard-and-redraw
// ability in their WHEN DRAWN text (e.g. Forward Position: "If it is the
// first battle round, you can draw one new Secondary Mission card and
// shuffle this card back into your Secondary Mission deck") — free, and
// separate from New Orders entirely (no CP cost, doesn't touch the
// once-per-battle limit). Detected generically from the card's own intro
// text rather than a fixed name list, so a future data refresh that adds
// or rewords cards doesn't need this list touched by hand.
//
// Most of these conditions are about the board (enemy unit stats,
// positioning) — nothing the app tracks, so they're just shown as plain
// text for the player to judge themselves, same as every other scoring
// condition already is. Two shapes ARE something the app already knows
// and can check for the player: "first battle round" (the tracker's own
// turn number) and the Plunder/Cleanse pair, whose condition is literally
// "the other one of these two is currently active for you" — checkable
// against this same side's active secondaries.
function cardRedrawAbility(card, side, tracker){
  const intro = card.intro || '';
  const isRedraw = /discard this card and draw one new|draw one new secondary mission card and shuffle this card back/i.test(intro);
  if(!isRedraw) return null;
  let eligible = null; // null = can't be checked here — player judges it
  if(/first battle round/i.test(intro)){
    eligible = tracker.turn === 1;
  } else if(card.key === 'plunder'){
    eligible = (side.secondaries || []).some(s => s.key === 'cleanse');
  } else if(card.key === 'cleanse'){
    eligible = (side.secondaries || []).some(s => s.key === 'plunder');
  }
  return { condition: intro, eligible };
}

// The long-press menu on an active Secondary Mission card. Three real,
// sourced mechanics for cycling a Tactical Secondary mid-battle (see
// scripts/fetch-secondary-missions.mjs for where "New Orders" was
// confirmed in Wahapedia's core Stratagems.csv, and the Core Rules'
// "Achieving Secondary Missions" step for the CP-discard): New Orders
// (1CP, discard this card and draw a new one, once per battle per side),
// a plain discard for 1CP (unlimited — the achieving-secondaries step
// doesn't cap how many times this can be used), and — only when this
// specific card's own text grants it — its own free discard-and-redraw
// (see cardRedrawAbility). Reuses the existing .modalOverlay pattern (see
// showManualInstallModal) rather than a new component.
function showSecondaryActionMenu(battleId, team, card, tracker){
  const side = team === 'my' ? tracker.my : tracker.opponent;
  const newOrdersDisabled = side.usedNewOrders || side.cp < 1;
  const ability = cardRedrawAbility(card, side, tracker);
  const abilityNote = ability
    ? `<div class="modalBody" style="margin-top:10px; font-size:10.5px;">${escapeHtml(ability.condition)}${ability.eligible === true ? ' — condition met.' : ability.eligible === false ? ' — condition not currently met.' : ' — you judge whether this applies.'}</div>`
    : '';
  const overlay = document.createElement('div');
  overlay.className = 'modalOverlay';
  overlay.innerHTML = `
    <div class="modalCard">
      <div class="modalTitle">${escapeHtml(card.displayName)}</div>
      <div class="modalBody">Choose an action for this Secondary Mission.</div>
      <button class="btn gold" id="secMenuNewOrders" style="margin-top:14px;" ${newOrdersDisabled ? 'disabled' : ''}>⚡ New Orders (1CP) — Discard &amp; Redraw${side.usedNewOrders ? ' (used)' : ''}</button>
      <button class="btn gold" id="secMenuDiscardCp" style="margin-top:8px;">💰 Discard (+1 CP)</button>
      ${ability ? `<button class="btn gold" id="secMenuCardRedraw" style="margin-top:8px;" ${ability.eligible === false ? 'disabled' : ''}>🔄 Discard &amp; Redraw (Card Ability)</button>${abilityNote}` : ''}
      <button class="btn ghost" id="secMenuCancel" style="margin-top:8px;">✕ Cancel</button>
    </div>
  `;
  overlay.addEventListener('click', (e) => { if(e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  document.getElementById('secMenuCancel').onclick = () => overlay.remove();
  document.getElementById('secMenuNewOrders').onclick = async () => {
    overlay.remove();
    const missionsData = await loadSecondaryMissionsData();
    if(!missionsData) return;
    await updateBattleTracker(battleId, t => {
      const s = team === 'my' ? t.my : t.opponent;
      if(s.usedNewOrders || s.cp < 1) return;
      s.cp -= 1;
      s.usedNewOrders = true;
      discardSecondaryCard(s, card.id);
      drawSecondaryCard(s, missionsData);
    });
    renderBattleTracker(battleId, 'tracker');
  };
  document.getElementById('secMenuDiscardCp').onclick = async () => {
    overlay.remove();
    await updateBattleTracker(battleId, t => {
      const s = team === 'my' ? t.my : t.opponent;
      discardSecondaryCard(s, card.id);
      s.cp += 1;
    });
    renderBattleTracker(battleId, 'tracker');
  };
  if(document.getElementById('secMenuCardRedraw')){
    document.getElementById('secMenuCardRedraw').onclick = async () => {
      overlay.remove();
      const missionsData = await loadSecondaryMissionsData();
      if(!missionsData) return;
      await updateBattleTracker(battleId, t => {
        const s = team === 'my' ? t.my : t.opponent;
        discardSecondaryCard(s, card.id);
        drawSecondaryCard(s, missionsData);
      });
      renderBattleTracker(battleId, 'tracker');
    };
  }
}

async function renderBattleTracker(battleId, tab){
  tab = tab || 'tracker';
  clearFooter();
  setStatus('', 'STANDBY');
  currentBattleContext = null;
  renderLoading('OPENING ARCHIVE', 'Loading battle tracker…');

  const battle0 = await getBattleById(battleId);
  if(!battle0){ renderBattleList(); return; }
  let battle = battle0;
  let tracker = ensureTracker(battle);

  // The Secondary Mission draw deck needs to exist (and be persisted, not
  // just held in memory) before the Tracker tab can render or draw from
  // it — lazily backfilled here rather than in ensureTracker itself, since
  // building the deck needs the mission data fetched first, and only the
  // Tracker tab ever needs it at all.
  let secondaryMissionsData = null;
  if(tab === 'tracker' && !tracker.finished){
    secondaryMissionsData = await loadSecondaryMissionsData();
    if(secondaryMissionsData){
      const allMissionKeys = secondaryMissionsData.missions.map(m => normalizeMissionKey(m.displayName));
      const updated = await updateBattleTracker(battleId, t => {
        ensureSecondaryDeck(t.my, allMissionKeys);
        ensureSecondaryDeck(t.opponent, allMissionKeys);
      });
      if(updated){ battle = updated; tracker = ensureTracker(battle); }
    }
  }

  const tabHtml = tab === 'my' ? buildTeamHtml(battle.myUnits, 'my', battle.myActiveDetachmentId)
    : tab === 'opponent' ? buildTeamHtml(battle.opponentUnits, 'opponent', battle.opponentActiveDetachmentId)
    : buildTrackerTabHtml(battle, tracker);
  const showAddUnits = (tab === 'my' || tab === 'opponent') && !tracker.finished;

  main.innerHTML = `
    <div class="tabBar">
      <button class="tabBtn${tab==='my'?' active':''}" data-tab="my">My Army</button>
      <button class="tabBtn${tab==='opponent'?' active':''}" data-tab="opponent">${escapeHtml(battle.opponent)}</button>
      <button class="tabBtn${tab==='tracker'?' active':''}" data-tab="tracker">Tracker</button>
    </div>
    ${tabHtml}
    ${showAddUnits ? `<button class="btn ghost" id="trackerAddUnitsBtn" style="margin-top:10px;">➕ Add Units to ${tab==='my'?'My Army':escapeHtml(battle.opponent)+"'s Army"}</button>` : ''}
  `;

  main.querySelectorAll('[data-tab]').forEach(btn => {
    btn.onclick = () => renderBattleTracker(battleId, btn.getAttribute('data-tab'));
  });

  if(tab === 'tracker' && document.getElementById('primaryMissionBtn')){
    document.getElementById('primaryMissionBtn').onclick = () => renderPrimaryMission(battleId, tab);
  }

  if(tab === 'my' || tab === 'opponent'){
    wireTeamCards(battle, battleId, tab,
      (unit) => renderRosterEntry(unit, battle, () => renderBattleTracker(battleId, tab), '← Back to Tracker'),
      () => renderBattleTracker(battleId, tab));
    if(document.getElementById('trackerAddUnitsBtn')){
      document.getElementById('trackerAddUnitsBtn').onclick = () => {
        // renderBattleScanChoice normally sets this before handing off to
        // renderBattleScanEntry — going there directly (already knowing
        // which side, since we're on that side's own tab) needs to set it
        // here instead, or a scanned/searched unit would never actually
        // get added to the battle.
        currentBattleContext = { battleId, team: tab, returnToTracker: true };
        renderBattleScanEntry(battleId, tab);
      };
    }
  }

  if(tab === 'tracker' && !tracker.finished){
    main.querySelectorAll('[data-cp-delta]').forEach(btn => {
      btn.onclick = async () => {
        const team = btn.getAttribute('data-cp-team');
        const delta = parseInt(btn.getAttribute('data-cp-delta'), 10);
        await updateBattleTracker(battleId, t => { t[team].cp = Math.max(0, t[team].cp + delta); });
        renderBattleTracker(battleId, 'tracker');
      };
    });
    main.querySelectorAll('[data-vp-team]').forEach(input => {
      input.addEventListener('change', async () => {
        const team = input.getAttribute('data-vp-team');
        const val = Math.max(0, parseInt(input.value, 10) || 0);
        await updateBattleTracker(battleId, t => { t[team].primaryVP = val; });
        renderBattleTracker(battleId, 'tracker');
      });
    });
    main.querySelectorAll('[data-draw-team]').forEach(btn => {
      btn.onclick = async () => {
        const team = btn.getAttribute('data-draw-team');
        const missionsData = secondaryMissionsData || await loadSecondaryMissionsData();
        if(!missionsData) return;
        await updateBattleTracker(battleId, t => {
          const s = t[team];
          if(s.secondaryLastDrawnTurn === t.turn) return;
          drawSecondaryCard(s, missionsData);
          drawSecondaryCard(s, missionsData);
          s.secondaryLastDrawnTurn = t.turn;
        });
        renderBattleTracker(battleId, 'tracker');
      };
    });
    main.querySelectorAll('.secItem[data-sec-id]:not([data-sec-completed])').forEach(el => {
      const team = el.getAttribute('data-sec-team');
      const secId = el.getAttribute('data-sec-id');
      const card = (tracker[team].secondaries || []).find(s => s.id === secId);
      if(!card) return;
      const wasLongPress = attachLongPress(el, () => showSecondaryActionMenu(battleId, team, card, tracker));
      el.addEventListener('click', () => {
        if(wasLongPress()) return;
        renderSecondaryMissionCard(battleId, team, secId, 'tracker');
      });
    });
    // Achieved cards stay tappable too — no long-press menu (New Orders/
    // discard don't apply to a card that's already banked), just a plain
    // open, so a mis-typed VP or an accidental achieve can still be fixed
    // instead of being locked in for the rest of the battle.
    main.querySelectorAll('.secItem[data-sec-completed]').forEach(el => {
      const team = el.getAttribute('data-sec-team');
      const secId = el.getAttribute('data-sec-id');
      el.addEventListener('click', () => renderSecondaryMissionCard(battleId, team, secId, 'tracker'));
    });
    document.getElementById('finishTurnBtn').onclick = async () => {
      if(tracker.turn >= TOTAL_TURNS){
        renderFinishGameConfirm(battleId);
        return;
      }
      await updateBattleTracker(battleId, t => { t.turn += 1; });
      await renderBattleTracker(battleId, 'tracker');
      // A long roster/secondaries list can leave the page scrolled well
      // down when Finish Turn is tapped — jump back to the top so the new
      // turn number and Primary Mission button are immediately visible
      // instead of requiring a manual scroll up.
      main.scrollTop = 0;
    };
    if(document.getElementById('prevTurnBtn')){
      document.getElementById('prevTurnBtn').onclick = async () => {
        await updateBattleTracker(battleId, t => { t.turn = Math.max(1, t.turn - 1); });
        await renderBattleTracker(battleId, 'tracker');
        main.scrollTop = 0;
      };
    }
  }

  // No visible footer while actively in a battle — the header's "✕" already
  // steps back to Battle Detail one screen at a time, so a second, always-
  // on "← Back to Battle" button here was redundant. A hidden marker keeps
  // that same nav-history/✕ behavior working correctly (see
  // battleDetailBackTarget for the identical pattern) without showing
  // anything for it.
  footer.style.display = 'none';
  main.insertAdjacentHTML('beforeend', `<button id="trackerBackTarget" data-nav-back style="display:none;"></button>`);
  document.getElementById('trackerBackTarget').onclick = () => renderBattleDetail(battleId);
}

function renderFinishGameConfirm(battleId){
  setStatus('', 'STANDBY');
  main.innerHTML = `
    <div class="errBox">
      <div class="errTitle">Finish the Game?</div>
      This locks in the final VP, CP, and secondaries for both sides. Nothing on the tracker can be changed after this.
    </div>
    <button class="btn primary" id="confirmFinishGameBtn" style="margin-top:14px;">✓ Yes, Finish Game</button>
    <button class="btn ghost" id="cancelFinishGameBtn" data-nav-back>← Cancel</button>
  `;
  document.getElementById('confirmFinishGameBtn').onclick = async () => {
    await updateBattleTracker(battleId, t => { t.finished = true; });
    renderBattleTracker(battleId, 'tracker');
  };
  document.getElementById('cancelFinishGameBtn').onclick = () => renderBattleTracker(battleId, 'tracker');
}

// ---------- SCREEN: MY COLLECTION ----------
async function renderCollectionList(){
  clearFooter();
  setStatus('', 'STANDBY');
  currentBattleContext = null;
  renderLoading('OPENING ARCHIVE', 'Loading your collection…');

  const list = await loadCollection();

  const emptyNote = `<div class="noteBox">No saved units yet. Open any datasheet and tap "Save to My Collection" to keep it here — reopen it anytime, or add it straight into a battle without rescanning.</div>`;
  const cards = list.map(u => {
    if(u.isFolder) return `
      <div class="libCard" data-id="${u.id}">
        <div class="libName">🗂 ${escapeHtml(u.folderName || 'Army List Units')}</div>
        <div class="libMeta">${u.units.length} unit${u.units.length===1?'':'s'}</div>
        <button class="btn ghost" data-del="${u.id}" style="margin-top:8px;">🗑 Remove</button>
      </div>
    `;
    if(u.isTextList) return `
      <div class="libCard" data-id="${u.id}">
        <div class="libName">📋 ${escapeHtml(u.listName || 'Imported List')}</div>
        <div class="libMeta">Text document</div>
        <button class="btn ghost" data-del="${u.id}" style="margin-top:8px;">🗑 Remove</button>
      </div>
    `;
    if(u.isDetachment) return `
      <div class="libCard" data-id="${u.id}">
        <div class="libName">📜 ${escapeHtml(u.card.displayName || 'Detachment')} Rules</div>
        <div class="libMeta">${escapeHtml(u.card.faction||'')} · Detachment Rules</div>
        <button class="btn ghost" data-del="${u.id}" style="margin-top:8px;">🗑 Remove</button>
      </div>
    `;
    return `
      <div class="libCard" data-id="${u.id}">
        <div class="libName">${escapeHtml(u.unit_name||'Unknown Unit')}</div>
        <div class="libMeta">${escapeHtml(u.faction||'')}${u.points ? ' · '+escapeHtml(u.points) : ''}</div>
        <button class="btn ghost" data-del="${u.id}" style="margin-top:8px;">🗑 Remove</button>
      </div>
    `;
  }).join('');

  main.innerHTML = `
    ${list.length ? '<div class="noteBox">Tap a saved unit, folder, list, or Detachment card to reopen it. Hold a unit or Detachment card to move it into an Army List folder.</div>' + cards : emptyNote}
    <button class="btn ghost" id="collectionHomeBtn" data-nav-back>🏠 Home</button>
  `;

  list.forEach(u => {
    const card = main.querySelector(`.libCard[data-id="${u.id}"]`);
    if(!card) return;
    // Only a standalone unit or Detachment card has somewhere sensible to
    // move to — a folder holds a units array and a detachmentCards array,
    // but nothing a folder itself or a text-list's single rawText field
    // could merge into.
    const canMove = !u.isFolder && !u.isTextList;
    const wasLongPress = canMove ? attachLongPress(card, () => renderMoveToFolderPicker(u)) : () => false;
    card.addEventListener('click', (e) => {
      if(e.target.closest('[data-del]')) return;
      if(wasLongPress()) return;
      if(u.isFolder) renderCollectionFolderView(u);
      else if(u.isTextList) renderTextListView(u, renderCollectionList, '← Back to Collection');
      else if(u.isDetachment) renderDetachmentRulesView(u.card, renderCollectionList, '← Back to Collection');
      else renderCollectionUnitView(u);
    });
  });
  main.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await removeUnitFromCollection(btn.getAttribute('data-del'));
      renderCollectionList();
    });
  });

  document.getElementById('collectionHomeBtn').onclick = renderHome;
}

function renderCollectionUnitView(unit){
  setStatus('', 'STANDBY');
  main.innerHTML = buildDatasheetSheetHtml(unit);
  footer.style.display = 'flex';
  footer.innerHTML = `<button class="btn ghost" id="collUnitBackBtn" data-nav-back>← Back to Collection</button>`;
  document.getElementById('collUnitBackBtn').onclick = renderCollectionList;
}

// A folder groups the units from one list upload together — this view
// lists what's inside, same pattern as My Collection itself but scoped to
// just this folder's units.
function renderCollectionFolderView(entry){
  clearFooter();
  setStatus('', 'STANDBY');
  const rows = entry.units.map((u, i) => `
    <div class="libCard" data-idx="${i}">
      <div class="libName">${escapeHtml(u.unit_name||'Unknown Unit')}</div>
      <div class="libMeta">${escapeHtml(u.faction||'')}${u.points ? ' · '+escapeHtml(u.points) : ''}</div>
    </div>
  `).join('');
  const detachmentCards = entry.detachmentCards || [];
  const detachButtons = detachmentCards.map((card, i) => `
    <button class="btn gold" data-detach-idx="${i}" style="margin-bottom:10px;">📜 ${escapeHtml(card.displayName || 'Detachment')} Rules</button>
  `).join('');
  main.innerHTML = `
    <div class="noteBox">🗂 <strong>${escapeHtml(entry.folderName || 'Army List Units')}</strong> — ${entry.units.length} unit${entry.units.length===1?'':'s'}. Tap a unit to view its full datasheet.</div>
    ${entry.rawText ? '<button class="btn gold" id="folderViewTextBtn" style="margin-bottom:10px;">📋 View Full List Text</button>' : ''}
    ${detachButtons}
    ${rows}
  `;
  footer.style.display = 'flex';
  footer.innerHTML = `<button class="btn ghost" id="collFolderBackBtn" data-nav-back>← Back to Collection</button>`;
  entry.units.forEach((u, i) => {
    const card = main.querySelector(`.libCard[data-idx="${i}"]`);
    if(card) card.addEventListener('click', () => renderCollectionFolderUnitView(entry, u));
  });
  if(entry.rawText){
    document.getElementById('folderViewTextBtn').onclick = () => {
      renderTextListView({ listName: entry.folderName, rawText: entry.rawText }, () => renderCollectionFolderView(entry), '← Back to Folder');
    };
  }
  detachmentCards.forEach((card, i) => {
    const btn = main.querySelector(`[data-detach-idx="${i}"]`);
    if(btn) btn.onclick = () => renderDetachmentRulesView(card, () => renderCollectionFolderView(entry), '← Back to Folder');
  });
  document.getElementById('collFolderBackBtn').onclick = renderCollectionList;
}

// Deposition (Purge the Foe, Take and Hold, Reconnaissance, Priority
// Assets, or Disruption) is assigned to a Detachment directly by the
// rules — it's a fixed property of card.disposition (from
// Detachments.csv's force_disposition column, see fetch-detachments.mjs),
// never something a player enters, so it always shows here whenever the
// card has one. Blank only for Boarding Actions-type detachments (a
// separate, smaller-scale game mode this data already excludes
// stratagems for elsewhere).
function buildDetachmentRulesHtml(card){
  const depositionHtml = card.disposition ? `
    <div class="sheetFaction" style="color:var(--parchment); margin-top:4px;">Deposition: ${escapeHtml(card.disposition)}</div>
  ` : '';
  const abilityHtml = card.ability ? `
    <div class="abilityItem">
      <div class="abilityName">${escapeHtml(card.ability.name||'')}</div>
      <div class="abilityDesc" style="white-space:pre-wrap;">${escapeHtml(htmlToPlainText(card.ability.description))}</div>
    </div>
  ` : `<div class="loadSub">No detachment rule text available.</div>`;

  const enhancementsHtml = (card.enhancements||[]).map(e => `
    <div class="abilityItem">
      <div class="abilityName">${escapeHtml(e.name||'')}${e.cost ? ' — '+escapeHtml(e.cost)+' pts' : ''}</div>
      <div class="abilityDesc" style="white-space:pre-wrap;">${escapeHtml(htmlToPlainText(e.description))}</div>
    </div>
  `).join('') || `<div class="loadSub">No enhancements listed.</div>`;

  const stratagemsHtml = (card.stratagems||[]).map(s => `
    <div class="abilityItem">
      <div class="abilityName">${escapeHtml(s.name||'')}${s.cpCost ? ' — '+escapeHtml(s.cpCost)+' CP' : ''}</div>
      <div class="libMeta" style="margin:2px 0 4px;">${escapeHtml([s.phase, s.turn].filter(Boolean).join(' · '))}</div>
      <div class="abilityDesc" style="white-space:pre-wrap;">${escapeHtml(htmlToPlainText(s.description))}</div>
    </div>
  `).join('') || `<div class="loadSub">No stratagems listed.</div>`;

  return `
    <div class="sheet">
      <div class="sheetHead">
        <div class="sheetName">${escapeHtml(card.displayName||'Detachment')}</div>
        <div class="sheetFaction">${escapeHtml(card.faction||'')} · Detachment Rules</div>
        ${depositionHtml}
      </div>
      <div class="section">
        <div class="sectionTitle">Detachment Rule</div>
        ${abilityHtml}
      </div>
      <div class="section">
        <div class="sectionTitle">Enhancements</div>
        ${enhancementsHtml}
      </div>
      <div class="section">
        <div class="sectionTitle">Stratagems</div>
        ${stratagemsHtml}
      </div>
      <div class="noteBox">Rules text from Wahapedia's public 11th-edition data export. Always confirm against your army's official app or GW source before a tournament.</div>
    </div>
  `;
}

async function renderDetachmentRulesView(card, onBack, backLabel){
  card = await withFreshDisposition(card);
  setStatus('', 'STANDBY');
  main.innerHTML = buildDetachmentRulesHtml(card);
  footer.style.display = 'flex';
  footer.innerHTML = `<button class="btn ghost" id="detachRulesBackBtn" data-nav-back>${escapeHtml(backLabel || '← Back')}</button>`;
  document.getElementById('detachRulesBackBtn').onclick = onBack;
}

// Same card view as above, but reached from the search box instead of an
// already-saved folder/collection entry — so it's not saved yet, and gets
// Save/Send actions instead of a plain back link. Actions sit above the
// card (which can run long — a rule plus every Enhancement and
// Stratagem) rather than after it, so they're there without scrolling.
// actionNote is an optional confirmation banner (e.g. after a Send)
// shown just above the actions on re-render.
function renderDetachmentSearchResult(card, actionNote){
  setStatus('', 'LINK ESTABLISHED');
  main.innerHTML = (actionNote || '') + `
    <button class="btn gold" id="saveDetachToCollectionBtn">💾 Save to My Collection</button>
    <button class="btn gold" id="sendDetachToFolderBtn" style="margin-top:8px;">📤 Send to Army Folder</button>
  ` + buildDetachmentRulesHtml(card);
  document.getElementById('saveDetachToCollectionBtn').onclick = async (e) => {
    await addDetachmentToCollection(card);
    const btn = e.currentTarget;
    btn.textContent = '✓ Saved to My Collection';
    btn.disabled = true;
  };
  document.getElementById('sendDetachToFolderBtn').onclick = () => {
    renderSendToFolderPicker(card.displayName || 'Detachment', 'Send', async (folder) => {
      await sendDetachmentToFolder(card, folder.id);
      renderDetachmentSearchResult(card, `<div class="noteBox">✓ Sent to <strong>${escapeHtml(folder.folderName || 'Army List Units')}</strong>.</div>`);
    }, () => renderDetachmentSearchResult(card));
  };
  footer.style.display = 'flex';
  footer.innerHTML = `<button class="btn ghost" id="detachSearchBackBtn" data-nav-back>← Home</button>`;
  document.getElementById('detachSearchBackBtn').onclick = renderHome;
}

function renderDetachmentFactionPicker(query, matches){
  setStatus('', 'STANDBY');
  main.innerHTML = `
    <div class="noteBox">"${escapeHtml(query)}" matches more than one Detachment. Which one do you want?</div>
    ${matches.map((m, i) => `<button class="btn gold" data-detach-match-idx="${i}" style="display:block; width:100%; margin-bottom:8px;">${escapeHtml(m.displayName || 'Detachment')} — ${escapeHtml(m.faction || 'Unknown Faction')}</button>`).join('')}
    <button class="btn ghost" id="detachPickerCancelBtn" data-nav-back style="margin-top:6px;">✕ Cancel</button>
  `;
  matches.forEach((m, i) => {
    document.querySelector(`[data-detach-match-idx="${i}"]`).onclick = () => renderDetachmentSearchResult(m);
  });
  document.getElementById('detachPickerCancelBtn').onclick = renderHome;
}

function renderCollectionFolderUnitView(entry, unit){
  setStatus('', 'STANDBY');
  main.innerHTML = buildDatasheetSheetHtml(unit);
  footer.style.display = 'flex';
  footer.innerHTML = `<button class="btn ghost" id="collFolderUnitBackBtn" data-nav-back>← Back to Folder</button>`;
  document.getElementById('collFolderUnitBackBtn').onclick = () => renderCollectionFolderView(entry);
}

// Read-only view of a saved text-list entry — just the pasted list text,
// shown verbatim rather than parsed into anything.
function renderTextListView(entry, onBack, backLabel){
  clearFooter();
  setStatus('', 'STANDBY');
  main.innerHTML = `
    <div class="noteBox">📋 <strong>${escapeHtml(entry.listName || 'Imported List')}</strong></div>
    <div class="sheet"><div class="section" style="white-space:pre-wrap; line-height:1.5; font-size:12.5px;">${escapeHtml(entry.rawText || '')}</div></div>
  `;
  footer.style.display = 'flex';
  footer.innerHTML = `<button class="btn ghost" id="textListBackBtn" data-nav-back>${escapeHtml(backLabel)}</button>`;
  document.getElementById('textListBackBtn').onclick = onBack;
}

// ---------- SCREEN: CUSTOM MODEL LIBRARY ----------
async function renderCustomLibrary(){
  clearFooter();
  setStatus('', 'STANDBY');
  renderLoading('OPENING ARCHIVE', 'Loading your custom models…');

  const list = await loadCustomModels();

  const emptyNote = `<div class="noteBox">No custom models yet. Register a conversion or proxy here — WarCamera 4k will recognize its photo on future scans and jump straight to the datasheet you assign it.</div>`;
  const cards = list.map(m => `
    <div class="libCard" data-id="${m.id}">
      <img class="libThumb" src="${m.thumb}" alt="${escapeHtml(m.label)}"/>
      <div class="libName">${escapeHtml(m.label)}</div>
      <div class="libMeta">${escapeHtml(m.unitName)}${m.faction ? ' · '+escapeHtml(m.faction) : ''}</div>
      <button class="btn ghost" data-del="${m.id}" style="margin-top:8px;">🗑 Remove</button>
    </div>
  `).join('');

  main.innerHTML = `
    ${list.length ? '<div class="noteBox">Tap a custom model to jump straight to its datasheet.</div>' + cards : emptyNote}
    <button class="btn primary" id="addCustomBtn">+ Add Custom Model</button>
    <button class="btn ghost" id="customHomeBtn" data-nav-back>🏠 Home</button>
  `;

  list.forEach(m => {
    const card = main.querySelector(`.libCard[data-id="${m.id}"]`);
    if(card){
      card.addEventListener('click', (e) => {
        if(e.target.closest('[data-del]')) return;
        fetchDatasheet(m.unitName, m.faction || '', 'direct');
      });
    }
  });
  main.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteCustomModel(btn.getAttribute('data-del'));
      renderCustomLibrary();
    });
  });

  document.getElementById('addCustomBtn').onclick = renderAddCustomChooser;
  document.getElementById('customHomeBtn').onclick = renderHome;
}

function renderAddCustomChooser(){
  setStatus('', 'STANDBY');
  main.innerHTML = `
    <div class="noteBox">Snap or upload a photo of your model, then tell WarCamera 4k which unit it represents.</div>
    <button class="btn primary" id="customCamBtn">📷 Take Photo</button>
    <button class="btn gold" id="customUploadBtn">🖼 Upload Photo</button>
    <input type="file" id="customFileInput" accept="image/*" style="display:none;" />
    <button class="btn ghost" id="customCancelBtn" data-nav-back>← Cancel</button>
  `;
  document.getElementById('customCamBtn').onclick = () => {
    onPhotoReady = handleCustomPhotoCaptured;
    onCameraCancel = renderCustomLibrary;
    openCamera();
  };
  document.getElementById('customUploadBtn').onclick = () => {
    document.getElementById('customFileInput').click();
  };
  document.getElementById('customFileInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = () => handleCustomPhotoCaptured(reader.result);
    reader.onerror = renderCustomLibrary;
    reader.readAsDataURL(file);
  });
  document.getElementById('customCancelBtn').onclick = renderCustomLibrary;
}

async function handleCustomPhotoCaptured(rawDataUrl){
  const thumb = await resizeImageDataUrl(rawDataUrl, 500, 0.75);
  renderCustomModelForm(thumb);
}

function renderCustomModelForm(thumb){
  setStatus('', 'STANDBY');
  main.innerHTML = `
    <img class="thumb" src="${thumb}" alt="new custom miniature"/>
    <div class="noteBox">What unit does this represent?</div>
    <input type="text" id="customLabelInput" placeholder="Label (optional), e.g. My Counts-As Captain" style="margin-top:8px;"/>
    <input type="text" id="customUnitInput" placeholder="Unit name, e.g. Captain in Gravis Armour" style="margin-top:8px;"/>
    <input type="text" id="customFactionInput" placeholder="Faction (optional)" style="margin-top:8px;"/>
    <button class="btn primary" id="saveCustomBtn" style="margin-top:12px;">✓ Save Custom Model</button>
    <button class="btn ghost" id="cancelCustomFormBtn" data-nav-back>✕ Cancel</button>
  `;
  document.getElementById('saveCustomBtn').onclick = async () => {
    const unitInput = document.getElementById('customUnitInput');
    const unitName = unitInput.value.trim();
    if(!unitName){ unitInput.focus(); return; }
    const label = document.getElementById('customLabelInput').value.trim() || unitName;
    const faction = document.getElementById('customFactionInput').value.trim();
    await addCustomModel({ label, unitName, faction, thumb });
    renderCustomLibrary();
  };
  document.getElementById('cancelCustomFormBtn').onclick = renderCustomLibrary;
}

// ---------- PHASE 2: STAT LOOKUP ----------
// mode: 'direct' renders the full datasheet immediately (manual search).
// mode: 'confirm' shows a quick stat-check screen first (photo ID path).
// Core network lookup — builds the prompt, calls Gemini, parses the result,
// and applies the official-points override. Returns the parsed datasheet or
// throws. Pulled out of fetchDatasheet() so the QR roster import flow (see
// runRosterImport) can reuse the exact same lookup headlessly, without any
// of fetchDatasheet's own loading/confirm/error screen rendering.
async function lookupDatasheetRaw(unitName, faction, isLight){
  // Check the scraped Wahapedia dataset before ever asking Gemini — when
  // this unit is in it, its stats/weapons/abilities come straight from
  // that authoritative, current-11e-only source, with no Gemini call at
  // all for this step. See loadDatasheetsData above for why. When a unit
  // has more than one faction's datasheet, this picks the one matching
  // `faction` if given (fetchDatasheet() already resolved that through
  // the picker for an interactive search with no hint) — a bulk import
  // with no faction hint just gets the first variant.
  const officialSheet = await lookupOfficialDatasheet(unitName, faction);
  let parsed;

  if(officialSheet){
    parsed = buildParsedFromOfficialDatasheet(officialSheet, isLight);
  } else {
    parsed = await lookupDatasheetFromGemini(unitName, faction, isLight);
  }

  // Points always come from the separate Field Manual dataset regardless
  // of where the rest of the datasheet came from — Wahapedia's export
  // doesn't include points at all.
  const officialPoints = await lookupOfficialPoints(parsed.unit_name);
  if(officialPoints){
    parsed.points = formatOfficialPoints(officialPoints);
    parsed.points_uncertain = false;
  }

  return parsed;
}

async function lookupDatasheetFromGemini(unitName, faction, isLight){
  const lightPrompt = `Give the current Warhammer 40,000 (11th edition) datasheet stat line for the unit "${unitName}"${faction ? ' from the '+faction+' faction' : ''}, from your own knowledge of the game. This is a quick stat check, not the full datasheet.
Stats and weapon profiles matter most here and change rarely — report them with your best knowledge whenever you can confidently identify the unit, even if you're not 100% sure every number reflects the very latest balance update. Points costs change far more often than stats and are the least reliable part of your knowledge: if you're unsure the points figure is current, still give your best-known value as a plain clean value (no "~", no extra wording — just e.g. "80 pts (5 models)") and instead set "points_uncertain" to true so the app can flag it separately. Never let uncertainty about points alone stop you from returning the rest of the datasheet.
Only use the error response below if you cannot confidently identify the unit itself or its core stats — not merely because its points might be outdated.
Respond with ONLY valid JSON, no markdown fences, no preamble, containing just the core stat line and weapons — nothing else:
{
 "unit_name": "...",
 "faction": "...",
 "points": "e.g. 80 pts (5 models) — your best-known value, plain text, no annotation",
 "points_uncertain": false,
 "stats": {"movement":"...", "toughness":"...", "save":"...", "wounds":"...", "leadership":"...", "oc":"...", "invulnerable_save":"... or null"},
 "weapons": [{"name":"...", "type":"Ranged or Melee", "range":"...", "attacks":"...", "skill":"...", "strength":"...", "ap":"...", "damage":"...", "abilities":"weapon special rules, short"}]
}
Do not include unit_composition, abilities, or keyword lists — they aren't needed for this quick check. If the unit itself cannot be confidently found, instead respond with ONLY: {"error": "explanation"}. Do not include anything outside the JSON object.`;

  const fullPrompt = `Give the current Warhammer 40,000 (11th edition) datasheet for the unit "${unitName}"${faction ? ' from the '+faction+' faction' : ''}, from your own knowledge of the game. Use the most current points and rules you know.
Stats, weapon profiles, and abilities matter most here and change rarely — report them with your best knowledge whenever you can confidently identify the unit, even if you're not 100% sure every detail reflects the very latest balance update. Points costs change far more often than the rest and are the least reliable part of your knowledge: if you're unsure the points figure is current, still give your best-known value as a plain clean value (no "~", no extra wording — just e.g. "80 pts (5 models)") and instead set "points_uncertain" to true so the app can flag it separately. Never let uncertainty about points alone stop you from returning the rest of the datasheet.
The weapons list must be COMPLETE, not just a default loadout: include every distinct weapon profile this unit can possibly take — every ranged and melee weapon option, every special/heavy weapon a model in the unit may be equipped with, every character/sergeant/champion-only wargear weapon, and every wargear substitution option (e.g. "any model can replace their bolt pistol with X", "one in every five models can take Y instead"). If the datasheet's wargear options section lists a weapon by name, that weapon needs its own entry in the weapons array with its full profile — do not collapse options down to just what a single "typical" loadout would carry.
Only use the error response below if you cannot confidently identify the unit itself or its core stats/weapons — not merely because its points might be outdated.
Respond with ONLY valid JSON, no markdown fences, no preamble, in exactly this shape:
{
 "unit_name": "...",
 "faction": "...",
 "points": "e.g. 80 pts (5 models) — your best-known value, plain text, no annotation",
 "points_uncertain": false,
 "unit_composition": "short plain text",
 "stats": {"movement":"...", "toughness":"...", "save":"...", "wounds":"...", "leadership":"...", "oc":"...", "invulnerable_save":"... or null"},
 "weapons": [{"name":"...", "type":"Ranged or Melee", "range":"...", "attacks":"...", "skill":"...", "strength":"...", "ap":"...", "damage":"...", "abilities":"weapon special rules, short"}] (every weapon option available to the unit — see instruction above, not just a default loadout),
 "abilities": [{"name":"...", "description":"paraphrased in your own words, one to two sentences, do not quote official rule text verbatim"}],
 "keywords": ["..."],
 "faction_keywords": ["..."]
}
If the unit itself cannot be confidently found, instead respond with ONLY: {"error": "explanation"}. Paraphrase all rules text — never copy Games Workshop's wording directly. Do not include anything outside the JSON object.`;

  // Request Google Search grounding so stats reflect current balance
  // updates, not just the model's training cutoff. Grounding needs a
  // billing-enabled Google Cloud project even within free-tier usage
  // volume — the worker tries this first, and if the key behind the
  // request (owner's or a visitor's own) has no billing attached, it
  // automatically retries the same request without grounding rather
  // than erroring, so lookups keep working either way. The prompts
  // above still ask the model to flag low confidence via the error
  // response, as a safety net for that non-grounded fallback path.
  const data = await callGemini({
    contents: [{ role: 'user', parts: [{ text: isLight ? lightPrompt : fullPrompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: { maxOutputTokens: isLight ? 2000 : 5000 },
  }, { model: TEXT_MODEL });

  const text = extractText(data);
  const parsed = parseJsonLoose(text);

  if(parsed.error){
    throw new Error(parsed.error);
  }

  return parsed;
}

async function fetchDatasheet(unitName, faction, mode){
  mode = mode || 'direct';
  setStatus('busy', 'RETRIEVING');
  renderLoading('CONSULTING ARCHIVES', `Pulling ${mode === 'confirm' ? 'quick stats' : 'full datasheet'} for ${unitName}…`);

  // Some units (e.g. Nurgle Daemon units also available to Death Guard)
  // have a separate official datasheet per faction. When the caller hasn't
  // already pinned one down — a plain name search, not a photo ID (which
  // already guesses a faction) or a re-fetch after picking one below —
  // ask which faction's version instead of silently guessing.
  if(!faction){
    const variants = await lookupOfficialDatasheetVariants(unitName);
    if(variants.length > 1){
      renderFactionPicker(unitName, variants, mode);
      return;
    }
  }

  const isLight = mode === 'confirm';

  try{
    const parsed = await lookupDatasheetRaw(unitName, faction, isLight);
    if(isLight){
      renderConfirm(parsed);
    } else {
      await renderDatasheet(parsed);
    }
  }catch(err){
    renderLookupError(err, unitName, mode);
  }
}

function renderFactionPicker(unitName, variants, mode){
  setStatus('', 'STANDBY');
  main.innerHTML = `
    <div class="noteBox">"${escapeHtml(unitName)}" has its own datasheet in more than one army. Which one do you want?</div>
    ${variants.map((v, i) => `<button class="btn gold" data-faction-idx="${i}" style="display:block; width:100%; margin-bottom:8px;">${escapeHtml(v.faction || 'Unknown Faction')}</button>`).join('')}
    <button class="btn ghost" id="factionPickerCancelBtn" data-nav-back style="margin-top:6px;">✕ Cancel</button>
  `;
  variants.forEach((v, i) => {
    document.querySelector(`[data-faction-idx="${i}"]`).onclick = () => fetchDatasheet(v.displayName || unitName, v.faction, mode);
  });
  document.getElementById('factionPickerCancelBtn').onclick = renderHome;
}

function renderLookupError(err, unitName, mode){
  setStatus('err', 'LINK ERROR');
  main.innerHTML = `
    <div class="errBox">
      <div class="errTitle">Archive Lookup Failed</div>
      Couldn't retrieve a confirmed datasheet for "${escapeHtml(unitName)}" (${escapeHtml(err.message||'unknown error')}). Check the spelling, or it may not be a current unit.
    </div>
    <button class="btn primary" id="retryBtn2" style="margin-top:14px;">↺ Try Again</button>
    <button class="btn ghost" id="homeBtn2" data-nav-back style="margin-top:10px;">← Home</button>
  `;
  document.getElementById('retryBtn2').onclick = () => fetchDatasheet(unitName, '', mode);
  document.getElementById('homeBtn2').onclick = renderHome;
}

// ---------- SCREEN: CONFIRM MATCH (base stats + weapon stats only) ----------
function renderConfirm(d){
  setStatus('', 'AWAITING CONFIRM');

  main.innerHTML = `
    ${lastImageDataUrl ? `<img class="thumb" src="${lastImageDataUrl}" alt="scanned miniature"/>` : ''}
    <div class="sheet" style="margin-top:12px;">
      <div class="sheetHead" style="position:relative;">
        <div class="sheetName">${escapeHtml(d.unit_name||'Unknown Unit')}</div>
        <div class="sheetFaction">${escapeHtml(d.faction||'')}</div>
      </div>
      ${buildStatGridHtml(d.stats)}
      ${buildWeaponsTableHtml(d.weapons)}
    </div>
    <div class="noteBox">Does this match the miniature?</div>
    <button class="btn primary" id="confirmYes" style="margin-top:6px;">✓ Correct — Show Full Datasheet</button>
    <button class="btn ghost" id="confirmNo">✕ Not a Match — Search by Name</button>
    <button class="btn ghost" id="confirmRescan">↺ Rescan</button>
    <button class="btn ghost" id="confirmHome" data-nav-back>🏠 Home</button>
  `;
  document.getElementById('confirmYes').onclick = () => fetchDatasheet(d.unit_name, d.faction, 'direct');
  document.getElementById('confirmNo').onclick = renderManualSearch;
  document.getElementById('confirmRescan').onclick = openCamera;
  document.getElementById('confirmHome').onclick = renderHome;
}

// ---------- SCREEN: DATASHEET ----------
// Shared by the live datasheet screen and the read-only view of a unit
// saved into a battle roster (renderBattleUnitView).
function buildDatasheetSheetHtml(d){
  const abilitiesHtml = (d.abilities||[]).map(a=>`
    <div class="abilityItem">
      <div class="abilityName">${escapeHtml(a.name||'')}</div>
      <div class="abilityDesc">${escapeHtml(a.description||'')}</div>
    </div>
  `).join('') || `<div class="loadSub">No special abilities listed.</div>`;

  const keywordChips = (d.keywords||[]).map(k=>`<span class="chip">${escapeHtml(k)}</span>`).join('');
  const factionChips = (d.faction_keywords||[]).map(k=>`<span class="chip">${escapeHtml(k)}</span>`).join('');

  return `
    <div class="sheet">
      <div class="sheetHead" style="position:relative;">
        <div class="sheetName">${escapeHtml(d.unit_name||'Unknown Unit')}</div>
        <div class="sheetFaction">${escapeHtml(d.faction||'')}</div>
        <div class="sheetPoints">${escapeHtml(d.points||'')}${d.points_uncertain ? '<span class="ptsFlag">*</span>' : ''}</div>
      </div>

      ${buildStatGridHtml(d.stats)}

      ${d.unit_composition ? `<div class="section"><div class="sectionTitle">Unit Composition</div><div class="abilityDesc">${escapeHtml(d.unit_composition)}</div></div>` : ''}

      ${buildWeaponsTableHtml(d.weapons)}

      <div class="section">
        <div class="sectionTitle">Abilities</div>
        ${abilitiesHtml}
      </div>

      ${keywordChips || factionChips ? `
      <div class="section">
        <div class="sectionTitle">Keywords</div>
        <div class="chips">${keywordChips}${factionChips}</div>
      </div>` : ''}

      ${d.points_uncertain ? `<div class="noteBox">* Points cost may have changed since a recent balance update — verify before a tournament.</div>` : ''}
      <div class="noteBox">Stats and rules come from the AI's own knowledge, not a live lookup, and are paraphrased rather than quoted. Always confirm against your army's official app or GW source before a tournament.</div>
    </div>
  `;
}

// The pure (side-effect-free) render for a looked-up datasheet — split
// out from renderDatasheet below so "Send to Army Folder" can bring the
// user back to this same screen afterward without re-running
// renderDatasheet's one-time addUnitToBattle call a second time.
// actionNote is an optional confirmation banner (e.g. after a Send) shown
// just above the actions on re-render. Actions sit above the sheet itself
// (which can run long) rather than after it, so they're there without
// scrolling.
function renderDatasheetSheetView(d, battleNote, actionNote){
  setStatus('', 'LINK ESTABLISHED');

  main.innerHTML = (battleNote || '') + (actionNote || '') + `
    <button class="btn gold" id="saveToCollectionBtn">💾 Save to My Collection</button>
    <button class="btn gold" id="sendToFolderBtn" style="margin-top:8px;">📤 Send to Army Folder</button>
  ` + buildDatasheetSheetHtml(d);
  document.getElementById('saveToCollectionBtn').onclick = async (e) => {
    await addUnitToCollection(d);
    const btn = e.currentTarget;
    btn.textContent = '✓ Saved to My Collection';
    btn.disabled = true;
  };
  document.getElementById('sendToFolderBtn').onclick = () => {
    renderSendToFolderPicker(d.unit_name || 'Unknown Unit', 'Send', async (folder) => {
      await sendUnitToFolder(d, folder.id);
      renderDatasheetSheetView(d, battleNote, `<div class="noteBox">✓ Sent to <strong>${escapeHtml(folder.folderName || 'Army List Units')}</strong>.</div>`);
    }, () => renderDatasheetSheetView(d, battleNote));
  };

  footer.style.display = 'flex';
  if(currentBattleContext){
    const ctx = currentBattleContext;
    footer.innerHTML = `
      <button class="btn ghost" id="homeFromSheet">🏠 Home</button>
      <button class="btn gold" id="scanMoreForBattle">📷 Scan Another</button>
      <button class="btn primary" id="backToBattleBtn" data-nav-back>⚔️ Battle</button>
    `;
    document.getElementById('homeFromSheet').onclick = renderHome;
    document.getElementById('scanMoreForBattle').onclick = () => renderBattleScanEntry(ctx.battleId, ctx.team);
    document.getElementById('backToBattleBtn').onclick = () => {
      currentBattleContext = null;
      // Reaching this screen via the Battle Tracker's own "Add Units"
      // (see renderBattleTracker) sets returnToTracker so finishing here
      // goes back to that same tab, not the plain roster screen.
      if(ctx.returnToTracker) renderBattleTracker(ctx.battleId, ctx.team);
      else renderBattleDetail(ctx.battleId);
    };
  } else {
    footer.innerHTML = `
      <button class="btn ghost" id="homeFromSheet" data-nav-back>🏠 Home</button>
      <button class="btn ghost" id="scanAgain">📷 Rescan</button>
      <button class="btn gold" id="searchAnother">🔎 Other</button>
    `;
    document.getElementById('homeFromSheet').onclick = renderHome;
    document.getElementById('scanAgain').onclick = openCamera;
    document.getElementById('searchAnother').onclick = renderManualSearch;
  }
}

async function renderDatasheet(d){
  // If this scan was started from a battle (see renderBattleScanChoice),
  // save it into that side's roster and swap the footer for battle
  // navigation instead of the normal Rescan/Other actions. This only
  // happens once, here — renderDatasheetSheetView above is what re-renders
  // this same screen afterward (e.g. after Send to Army Folder) without
  // adding the unit to the battle a second time.
  let battleNote = '';
  const battleCtx = currentBattleContext;
  if(battleCtx){
    const battle = await getBattleById(battleCtx.battleId);
    if(battle){
      await addUnitToBattle(battleCtx.battleId, battleCtx.team, d);
      const teamLabel = battleCtx.team === 'my' ? 'My Army' : `${battle.opponent}'s Army`;
      battleNote = `<div class="noteBox" style="border-bottom:1px dashed var(--iron); padding-bottom:12px;">✓ Added to <strong>${escapeHtml(teamLabel)}</strong> for this battle.</div>`;
    } else {
      currentBattleContext = null; // battle no longer exists (e.g. deleted mid-scan)
    }
  }
  renderDatasheetSheetView(d, battleNote);
}

function escapeHtml(str){
  if(str===undefined || str===null) return '';
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Once installed, the PWA's service worker only checks for a new version on
// its own schedule (the browser throttles this to roughly once a day), so a
// deploy can go unnoticed for a long time even though skipWaiting/clientsClaim
// (see vite.config.js's registerType: 'autoUpdate') would apply it instantly
// once found. Actively re-check whenever the app is opened or brought back to
// the foreground, and reload as soon as a new version takes control, so a
// fresh deploy shows up within seconds instead of up to a day later.
if('serviceWorker' in navigator){
  // clientsClaim() (see vite.config.js) makes even a brand-new page's very
  // first load fire 'controllerchange' — going from no controller to one —
  // which is not an update and must not trigger a reload. Only a *second*
  // controllerchange, replacing an already-set controller, is a real update.
  let hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if(!hadController){ hadController = true; return; }
    if(reloading) return;
    reloading = true;
    window.location.reload();
  });
  navigator.serviceWorker.ready.then(reg => {
    reg.update();
    document.addEventListener('visibilitychange', () => {
      if(document.visibilityState === 'visible') reg.update();
    });
  }).catch(() => {});
}

// Shared by the global "✕" and the phone's own back button/gesture below —
// steps back exactly one screen rather than jumping all the way Home. Each
// screen marks its own correct "back" action with a data-nav-back
// attribute (almost always the same button/onclick a visible Back/Cancel/
// Home control on that screen already uses — see the many small edits
// throughout this file — so this reuses logic that's already correct per
// screen instead of tracking a separate navigation history). stopCamera()
// is a no-op when nothing's active, so it's safe to call unconditionally
// here too, on top of whatever the matched back target does itself.
function goBackOneScreen(){
  stopCamera();
  const backTarget = document.querySelector('[data-nav-back]');
  if(backTarget) backTarget.click();
  else renderHome(); // safety net for the rare screen with no back target marked
}

// Global "✕" in the header — same corner on every screen since the header
// itself is static markup (only #main/#footer get re-rendered per screen).
const globalCloseBtn = document.getElementById('globalCloseBtn');
globalCloseBtn.onclick = goBackOneScreen;

// Home has nowhere further back to go, so the close button has nothing to
// do there — hidden rather than shown-but-inert. #scanBtn only ever exists
// on Home, so checking for it after every #main repaint (instead of
// threading visibility into all 44 render functions) is enough to track
// this with a single small observer.
function isOnHome(){ return !!document.getElementById('scanBtn'); }

// The phone's own back button/gesture used to just reload the app back to
// its single starting history entry (since nothing here ever called
// pushState), which looks like "back always dumps you on Home" no matter
// how deep you were. Fixed with the standard SPA trick: keep a real
// history entry per screen depth, so the phone's own back mechanism has
// something legitimate to pop each time.
//
// An earlier version of this pushed a fresh entry reactively from inside
// the popstate handler itself (immediately re-arming a single "cushion"
// entry on every back press). Real phones reportedly still got kicked out
// of the app after a couple of ordinary back presses, so it moved to
// pushing proactively during forward navigation instead — but that
// version pushed on *every* non-Home #main repaint unconditionally,
// including every renderLoading() spinner (most screens show one before
// their real content — see e.g. renderCollectionList), so a single
// screen transition often pushed twice, and normal browsing before ever
// touching the back button could rack up a lot of pushState calls.
// Chrome throttles History API calls past 100 within 10 seconds and just
// silently ignores the rest past that point — no error, no warning, the
// entry simply never gets added — which fits exactly what got reported:
// back button working correctly at first, then eventually exiting the
// app outright with no code change in between. Two fixes:
//
// 1. Only push for a repaint that actually has its own data-nav-back
//    target — a loading spinner never does, so this skips it entirely
//    instead of giving it a throwaway entry, roughly halving push volume
//    across the whole app.
// 2. suppressHistoryPush now clears on a macrotask (setTimeout), not a
//    microtask (Promise.resolve().then(...)). goBackOneScreen() can land
//    on a screen whose render function is itself async and shows a
//    loading spinner before its real content — that real-content repaint
//    only happens after an extra await hop, which a microtask-based
//    reset does NOT wait for: it fired the flag back to false in between
//    the spinner repaint (correctly suppressed) and the real-content
//    repaint (wrongly un-suppressed by then), so going back into exactly
//    this kind of screen — My Collection among them — silently pushed a
//    phantom forward entry on every single back press, compounding the
//    same over-pushing problem from the *other* direction. A macrotask
//    always runs after the full microtask queue (and everything chained
//    off it, however many awaits deep) has drained.
// 3. lastKnownBackId tracks the id of whichever data-nav-back element is
//    currently on screen, and a push only happens when that id actually
//    *changes* — a screen re-rendering itself in place (a tab switch on
//    a multi-tab screen like the Battle Tracker, or the Send-to-Folder
//    confirmation note) keeps the same id and correctly gets no new
//    entry, while a genuinely different screen (even one sharing another
//    screen's id from earlier, like two different folders) still does.
//    Always kept in sync regardless of suppression, so it can't drift
//    stale across a back navigation and wrongly skip a push afterward.
let suppressHistoryPush = false;
let lastKnownBackId = null;
function syncMainObserverEffects(){
  const onHome = isOnHome();
  globalCloseBtn.style.display = onHome ? 'none' : 'flex';
  if(onHome){ lastKnownBackId = null; return; }
  const backTarget = document.querySelector('[data-nav-back]');
  const currentId = backTarget ? (backTarget.id || 'anon') : null;
  if(!currentId) return; // transient screen (loading spinner, mainly) — nothing to anchor a history entry to, and no identity worth remembering
  const isNewScreen = currentId !== lastKnownBackId;
  lastKnownBackId = currentId;
  if(suppressHistoryPush || !isNewScreen) return;
  history.pushState({ app: true }, '');
}
new MutationObserver(syncMainObserverEffects).observe(main, { childList: true });

window.addEventListener('popstate', () => {
  // isOnHome() here reads the DOM as it stood *before* this back press —
  // popping history doesn't touch #main by itself, only our own code
  // does, via goBackOneScreen() below. Home already has nothing pushed
  // for it (see syncMainObserverEffects), so on Home this deliberately
  // does nothing and lets the real, uncaptured back navigation proceed —
  // leaving/closing the app, exactly like there being no "✕" to press.
  if(isOnHome()) return;
  suppressHistoryPush = true;
  goBackOneScreen();
  setTimeout(() => { suppressHistoryPush = false; }, 50);
});

// init
renderHome();
syncMainObserverEffects(); // observer callbacks are async — set the correct initial state synchronously too, so the "✕" is never visible even for a frame on first load
