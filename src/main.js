import './style.css';
import { callGemini } from './api.js';
import { loadCustomModels, saveCustomModelsList, loadUserApiKey, saveUserApiKey, loadBattles, saveBattlesList } from './storage.js';

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
    <button class="btn gold" id="uploadBtn">🖼 Upload a Photo</button>
    <input type="file" id="fileInput" accept="image/*" style="display:none;" />
    <button class="btn ghost" id="customLibBtn">📋 My Custom Models</button>
    <button class="btn ghost" id="battlesBtn">⚔️ Battles</button>
    <button class="btn ghost" id="apiKeyBtn">🔑 API Key Settings</button>
    <div class="divider">or</div>
    <input type="text" id="manualInput" placeholder="Type a unit name, e.g. Intercessor Squad" />
    <button class="btn gold" id="manualBtn">🔎 Look Up Datasheet</button>
    <div class="noteBox">
      Visual identification is AI best-effort — paint jobs, conversions and unpainted models reduce accuracy.
      You'll be able to confirm or correct the result before stats are pulled up.
      Stats come from the AI's own knowledge, not a live lookup, so a recent points/balance update might not be reflected. Rule text is paraphrased, not quoted verbatim from Games Workshop.
      If your browser blocks camera access, Upload a Photo works instead — it uses your device's normal photo picker rather than a live camera feed.
      Got your own conversions or proxies? Register them under My Custom Models so future scans recognize them instantly.
      Playing a game? Start a Battle to log which units you and your opponent have on the table, with one tap back to any datasheet.
    </div>
  `;
  if(document.getElementById('installBtn')) document.getElementById('installBtn').onclick = handleInstall;
  document.getElementById('scanBtn').onclick = openCamera;

  document.getElementById('uploadBtn').onclick = () => {
    document.getElementById('fileInput').click();
  };
  document.getElementById('fileInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = () => identifyFromImage(reader.result);
    reader.onerror = () => renderIdError({message:'Could not read that file'}, null);
    reader.readAsDataURL(file);
  });

  document.getElementById('customLibBtn').onclick = renderCustomLibrary;
  document.getElementById('battlesBtn').onclick = renderBattleList;
  document.getElementById('apiKeyBtn').onclick = renderApiKeySettings;

  document.getElementById('manualBtn').onclick = () => {
    const v = document.getElementById('manualInput').value.trim();
    if(v) fetchDatasheet(v, '');
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
    <button class="btn ghost" id="cancelPrimeBtn" style="margin-top:10px;">← Cancel</button>
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
      <div class="smallCircle" id="camCancel">✕</div>
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
    <button class="btn ghost" id="homeBtnNF" style="margin-top:10px;">← Home</button>
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
    <button class="btn ghost" id="homeBtnUnsup" style="margin-top:10px;">← Home</button>
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
    <button class="btn ghost" id="backBtn" style="margin-top:10px;">← Back</button>
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
  entry.id = 'cm_' + Date.now();
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
`You are looking at a photo of a Warhammer 40,000 tabletop miniature${customModels.length ? ' (the NEW PHOTO above)' : ''}. ${customModels.length ? 'First check it against the numbered custom references above for a strong visual match — if it clearly matches one, use the assigned unit_name/faction from that reference and set matched_custom_id. Otherwise, ' : ''}identify which current 10th-edition unit datasheet this model most likely represents.

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
    <button class="btn ghost" id="homeBtn" style="margin-top:10px;">← Home</button>
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
    <button class="btn ghost" id="settingsHomeBtn">🏠 Home</button>
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
  const battle = { id: 'battle_'+Date.now(), opponent, date, createdAt: Date.now(), myUnits: [], opponentUnits: [] };
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
  const entry = Object.assign({}, unit, { id: 'u_'+Date.now(), addedAt: Date.now() });
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
    <button class="btn ghost" id="battlesHomeBtn">🏠 Home</button>
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
    <button class="btn ghost" id="cancelNewBattleBtn">✕ Cancel</button>
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
async function renderBattleDetail(battleId){
  clearFooter();
  setStatus('', 'STANDBY');
  currentBattleContext = null;
  renderLoading('OPENING ARCHIVE', 'Loading battle…');

  const battle = await getBattleById(battleId);
  if(!battle){ renderBattleList(); return; }

  const buildTeamHtml = (units, team) => {
    if(!units.length) return `<div class="noteBox">No units scanned for this side yet.</div>`;
    return units.map(u => `
      <div class="libCard" data-unit="${u.id}" data-team="${team}">
        <div class="libName">${escapeHtml(u.unit_name||'Unknown Unit')}</div>
        <div class="libMeta">${escapeHtml(u.faction||'')}${u.points ? ' · '+escapeHtml(u.points) : ''}</div>
        <button class="btn ghost" data-remove="${u.id}" data-remove-team="${team}" style="margin-top:8px;">🗑 Remove</button>
      </div>
    `).join('');
  };

  main.innerHTML = `
    <div class="noteBox">vs <strong>${escapeHtml(battle.opponent)}</strong> — ${escapeHtml(formatBattleDate(battle.date))}</div>
    <div class="sectionTitle" style="padding:0 2px;">My Army (${battle.myUnits.length})</div>
    ${buildTeamHtml(battle.myUnits, 'my')}
    <div class="sectionTitle" style="padding:0 2px; margin-top:8px;">${escapeHtml(battle.opponent)}'s Army (${battle.opponentUnits.length})</div>
    ${buildTeamHtml(battle.opponentUnits, 'opponent')}
    <button class="btn primary" id="scanForBattleBtn" style="margin-top:14px;">📷 Scan a Unit</button>
    <button class="btn ghost" id="deleteBattleBtn">🗑 Delete This Battle</button>
    <button class="btn ghost" id="battleDetailHomeBtn">🏠 Home</button>
  `;

  main.querySelectorAll('[data-unit]').forEach(card => {
    card.addEventListener('click', (e) => {
      if(e.target.closest('[data-remove]')) return;
      const unitId = card.getAttribute('data-unit');
      const team = card.getAttribute('data-team');
      const unit = (team === 'my' ? battle.myUnits : battle.opponentUnits).find(u => u.id === unitId);
      if(unit) renderBattleUnitView(battle, unit);
    });
  });
  main.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await removeUnitFromBattle(battleId, btn.getAttribute('data-remove-team'), btn.getAttribute('data-remove'));
      renderBattleDetail(battleId);
    });
  });

  document.getElementById('scanForBattleBtn').onclick = () => renderBattleScanChoice(battleId);
  document.getElementById('deleteBattleBtn').onclick = () => renderDeleteBattleConfirm(battle);
  document.getElementById('battleDetailHomeBtn').onclick = renderHome;
}

function renderDeleteBattleConfirm(battle){
  main.innerHTML = `
    <div class="errBox">
      <div class="errTitle">Delete This Battle?</div>
      This permanently deletes the battle vs ${escapeHtml(battle.opponent)} and all ${battle.myUnits.length + battle.opponentUnits.length} logged units. This can't be undone.
    </div>
    <button class="btn primary" id="confirmDeleteBattleBtn" style="margin-top:14px;">🗑 Yes, Delete It</button>
    <button class="btn ghost" id="cancelDeleteBattleBtn">← Cancel</button>
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
    <button class="btn ghost" id="cancelScanChoiceBtn">← Cancel</button>
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
    <input type="text" id="battleManualInput" placeholder="Type a unit name, e.g. Intercessor Squad" />
    <button class="btn gold" id="battleManualBtn">🔎 Look Up Datasheet</button>
    <button class="btn ghost" id="battleScanCancelBtn" style="margin-top:10px;">← Back to Battle</button>
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
  document.getElementById('battleScanCancelBtn').onclick = () => {
    currentBattleContext = null;
    renderBattleDetail(battleId);
  };
}

// ---------- SCREEN: BATTLE — VIEW A SAVED UNIT (read-only) ----------
function renderBattleUnitView(battle, unit){
  setStatus('', 'STANDBY');
  main.innerHTML = buildDatasheetSheetHtml(unit);
  footer.style.display = 'flex';
  footer.innerHTML = `<button class="btn ghost" id="unitBackBtn">← Back to Battle</button>`;
  document.getElementById('unitBackBtn').onclick = () => renderBattleDetail(battle.id);
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
    <button class="btn ghost" id="customHomeBtn">🏠 Home</button>
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
    <button class="btn ghost" id="customCancelBtn">← Cancel</button>
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
    <button class="btn ghost" id="cancelCustomFormBtn">✕ Cancel</button>
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
async function fetchDatasheet(unitName, faction, mode){
  mode = mode || 'direct';
  setStatus('busy', 'RETRIEVING');
  renderLoading('CONSULTING ARCHIVES', `Pulling ${mode === 'confirm' ? 'quick stats' : 'full datasheet'} for ${unitName}…`);

  const isLight = mode === 'confirm';

  const lightPrompt = `Give the current Warhammer 40,000 (10th edition) datasheet stat line for the unit "${unitName}"${faction ? ' from the '+faction+' faction' : ''}, from your own knowledge of the game. This is a quick stat check, not the full datasheet.
Stats and weapon profiles matter most here and change rarely — report them with your best knowledge whenever you can confidently identify the unit, even if you're not 100% sure every number reflects the very latest balance update. Points costs change far more often than stats and are the least reliable part of your knowledge: if you're unsure the points figure is current, still give your best-known value but prefix it with "~" and add "(may have changed)", e.g. "~80 pts (5 models, may have changed)" — never let uncertainty about points alone stop you from returning the rest of the datasheet.
Only use the error response below if you cannot confidently identify the unit itself or its core stats — not merely because its points might be outdated.
Respond with ONLY valid JSON, no markdown fences, no preamble, containing just the core stat line and weapons — nothing else:
{
 "unit_name": "...",
 "faction": "...",
 "points": "e.g. 80 pts (5 models), or ~80 pts (5 models, may have changed) if unsure",
 "stats": {"movement":"...", "toughness":"...", "save":"...", "wounds":"...", "leadership":"...", "oc":"...", "invulnerable_save":"... or null"},
 "weapons": [{"name":"...", "type":"Ranged or Melee", "range":"...", "attacks":"...", "skill":"...", "strength":"...", "ap":"...", "damage":"...", "abilities":"weapon special rules, short"}]
}
Do not include unit_composition, abilities, or keyword lists — they aren't needed for this quick check. If the unit itself cannot be confidently found, instead respond with ONLY: {"error": "explanation"}. Do not include anything outside the JSON object.`;

  const fullPrompt = `Give the current Warhammer 40,000 (10th edition) datasheet for the unit "${unitName}"${faction ? ' from the '+faction+' faction' : ''}, from your own knowledge of the game. Use the most current points and rules you know.
Stats, weapon profiles, and abilities matter most here and change rarely — report them with your best knowledge whenever you can confidently identify the unit, even if you're not 100% sure every detail reflects the very latest balance update. Points costs change far more often than the rest and are the least reliable part of your knowledge: if you're unsure the points figure is current, still give your best-known value but prefix it with "~" and add "(may have changed)", e.g. "~80 pts (5 models, may have changed)" — never let uncertainty about points alone stop you from returning the rest of the datasheet.
Only use the error response below if you cannot confidently identify the unit itself or its core stats/weapons — not merely because its points might be outdated.
Respond with ONLY valid JSON, no markdown fences, no preamble, in exactly this shape:
{
 "unit_name": "...",
 "faction": "...",
 "points": "e.g. 80 pts (5 models), or ~80 pts (5 models, may have changed) if unsure",
 "unit_composition": "short plain text",
 "stats": {"movement":"...", "toughness":"...", "save":"...", "wounds":"...", "leadership":"...", "oc":"...", "invulnerable_save":"... or null"},
 "weapons": [{"name":"...", "type":"Ranged or Melee", "range":"...", "attacks":"...", "skill":"...", "strength":"...", "ap":"...", "damage":"...", "abilities":"weapon special rules, short"}],
 "abilities": [{"name":"...", "description":"paraphrased in your own words, one to two sentences, do not quote official rule text verbatim"}],
 "keywords": ["..."],
 "faction_keywords": ["..."]
}
If the unit itself cannot be confidently found, instead respond with ONLY: {"error": "explanation"}. Paraphrase all rules text — never copy Games Workshop's wording directly. Do not include anything outside the JSON object.`;

  try{
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
      generationConfig: { maxOutputTokens: isLight ? 2000 : 3500 },
    }, { model: TEXT_MODEL });

    const text = extractText(data);
    const parsed = parseJsonLoose(text);

    if(parsed.error){
      throw new Error(parsed.error);
    }

    if(isLight){
      renderConfirm(parsed);
    } else {
      await renderDatasheet(parsed);
    }

  }catch(err){
    renderLookupError(err, unitName, mode);
  }
}

function renderLookupError(err, unitName, mode){
  setStatus('err', 'LINK ERROR');
  main.innerHTML = `
    <div class="errBox">
      <div class="errTitle">Archive Lookup Failed</div>
      Couldn't retrieve a confirmed datasheet for "${escapeHtml(unitName)}" (${escapeHtml(err.message||'unknown error')}). Check the spelling, or it may not be a current unit.
    </div>
    <button class="btn primary" id="retryBtn2" style="margin-top:14px;">↺ Try Again</button>
    <button class="btn ghost" id="homeBtn2" style="margin-top:10px;">← Home</button>
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
    <button class="btn ghost" id="confirmHome">🏠 Home</button>
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
        <div class="sheetPoints">${escapeHtml(d.points||'')}</div>
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

      <div class="noteBox">Stats and rules come from the AI's own knowledge, not a live lookup, and are paraphrased rather than quoted. Always confirm against your army's official app or GW source before a tournament.</div>
    </div>
  `;
}

async function renderDatasheet(d){
  setStatus('', 'LINK ESTABLISHED');

  // If this scan was started from a battle (see renderBattleScanChoice),
  // save it into that side's roster and swap the footer for battle
  // navigation instead of the normal Rescan/Other actions.
  let battleNote = '';
  const battleCtx = currentBattleContext;
  let battle = null;
  if(battleCtx){
    battle = await getBattleById(battleCtx.battleId);
    if(battle){
      await addUnitToBattle(battleCtx.battleId, battleCtx.team, d);
      const teamLabel = battleCtx.team === 'my' ? 'My Army' : `${battle.opponent}'s Army`;
      battleNote = `<div class="noteBox" style="border-bottom:1px dashed var(--iron); padding-bottom:12px;">✓ Added to <strong>${escapeHtml(teamLabel)}</strong> for this battle.</div>`;
    } else {
      currentBattleContext = null; // battle no longer exists (e.g. deleted mid-scan)
    }
  }

  main.innerHTML = battleNote + buildDatasheetSheetHtml(d);

  footer.style.display = 'flex';
  if(currentBattleContext){
    const ctx = currentBattleContext;
    footer.innerHTML = `
      <button class="btn ghost" id="homeFromSheet">🏠 Home</button>
      <button class="btn gold" id="scanMoreForBattle">📷 Scan Another</button>
      <button class="btn primary" id="backToBattleBtn">⚔️ Battle</button>
    `;
    document.getElementById('homeFromSheet').onclick = renderHome;
    document.getElementById('scanMoreForBattle').onclick = () => renderBattleScanEntry(ctx.battleId, ctx.team);
    document.getElementById('backToBattleBtn').onclick = () => {
      currentBattleContext = null;
      renderBattleDetail(ctx.battleId);
    };
  } else {
    footer.innerHTML = `
      <button class="btn ghost" id="homeFromSheet">🏠 Home</button>
      <button class="btn ghost" id="scanAgain">📷 Rescan</button>
      <button class="btn gold" id="searchAnother">🔎 Other</button>
    `;
    document.getElementById('homeFromSheet').onclick = renderHome;
    document.getElementById('scanAgain').onclick = openCamera;
    document.getElementById('searchAnother').onclick = renderManualSearch;
  }
}

function escapeHtml(str){
  if(str===undefined || str===null) return '';
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// init
renderHome();
