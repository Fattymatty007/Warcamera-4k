import './style.css';
import { callGemini } from './api.js';
import { loadCustomModels, saveCustomModelsList } from './storage.js';

// The model itself is fixed in the Cloudflare Worker's request URL (see
// worker/src/index.js) — not sent from here, since Gemini's endpoint is
// per-model rather than taking a `model` field in the request body.

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
      <div class="modalTitle">Install Auspex Scanner</div>
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
  main.innerHTML = `
    ${canInstall() ? '<button class="btn gold" id="installBtn">⬇ Install App</button>' : ''}
    <button class="btn primary" id="scanBtn">📷 Scan Miniature</button>
    <button class="btn gold" id="uploadBtn">🖼 Upload a Photo</button>
    <input type="file" id="fileInput" accept="image/*" style="display:none;" />
    <button class="btn ghost" id="customLibBtn">📋 My Custom Models</button>
    <div class="divider">or</div>
    <input type="text" id="manualInput" placeholder="Type a unit name, e.g. Intercessor Squad" />
    <button class="btn gold" id="manualBtn">🔎 Look Up Datasheet</button>
    <div class="noteBox">
      Visual identification is AI best-effort — paint jobs, conversions and unpainted models reduce accuracy.
      You'll be able to confirm or correct the result before stats are pulled from Wahapedia.
      Rule text is paraphrased, not quoted verbatim from Games Workshop.
      If your browser blocks camera access, Upload a Photo works instead — it uses your device's normal photo picker rather than a live camera feed.
      Got your own conversions or proxies? Register them under My Custom Models so future scans recognize them instantly.
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
      Auspex Scanner needs permission to use your camera to photograph miniatures.
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
      <div class="errTitle">Auspex Link Failed</div>
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
    throw new Error('Got an incomplete or malformed response — please try again.');
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

Before answering, look closely at distinguishing physical details rather than just overall silhouette or faction theme — many large monster/character models from the same faction look similar at a glance but differ in specifics. Check things like: exact head count, what (if anything) is held in each hand (staff vs sword vs no weapon), wing type and shape, base size, and any unique iconography or asymmetry. Commonly confused pairs include, for example, Kairos Fateweaver (two heads, carries a staff) vs Magnus the Red (one head, no staff, more armoured/sorcerous look) among large Tzeentch models — use that kind of feature-level comparison for any faction, not just this example.

Respond with ONLY valid JSON, no markdown fences, no preamble, in exactly this shape:
{"matched_custom_id": "the custom_id if this is clearly one of the registered custom models above, else null", "reasoning": "1-2 sentences on the specific visual features you compared and why they point to your answer", "identified": true or false, "unit_name": "your single best-match unit name (or the matched custom model's assigned unit)", "faction": "...", "confidence": "high"|"medium"|"low", "notes": "one short sentence about paint scheme, conversion, or ambiguity if relevant, else empty string"}
Give only your single best match, not a ranked list. Do not include any text outside the JSON object.`
  });

  try{
    const data = await callGemini({
      contents: [{ role: 'user', parts }],
      generationConfig: { maxOutputTokens: 1200 },
    });

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

// ---------- SCREEN: CUSTOM MODEL LIBRARY ----------
async function renderCustomLibrary(){
  clearFooter();
  setStatus('', 'STANDBY');
  renderLoading('OPENING ARCHIVE', 'Loading your custom models…');

  const list = await loadCustomModels();

  const emptyNote = `<div class="noteBox">No custom models yet. Register a conversion or proxy here — Auspex will recognize its photo on future scans and jump straight to the datasheet you assign it.</div>`;
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
    <div class="noteBox">Snap or upload a photo of your model, then tell Auspex which unit it represents.</div>
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

  const lightPrompt = `Search Wahapedia.com for the current Warhammer 40,000 (10th edition) datasheet for the unit "${unitName}"${faction ? ' from the '+faction+' faction' : ''}. This is a quick stat check, not the full datasheet — be efficient, but getting real numbers matters more than saving a search.
Start with one targeted query like "${unitName} Wahapedia 10th edition datasheet". Wahapedia's stat table sometimes doesn't appear in a search snippet even though the page has it — if your first result doesn't give you the actual numeric stat line and weapon profile numbers, don't give up: run one more search, either rephrased (add words like "toughness wounds save attacks") or targeting a plain-text secondary source that quotes the same current official numbers (a community wiki, army-list builder export, or site like Goonhammer). Never fabricate, estimate, or guess a number — only report figures you actually found in a search result. Only return the error JSON if two searches still don't confirm the numbers.
Respond with ONLY valid JSON, no markdown fences, no preamble, containing just the core stat line and weapons — nothing else:
{
 "unit_name": "...",
 "faction": "...",
 "points": "e.g. 80 pts (5 models)",
 "stats": {"movement":"...", "toughness":"...", "save":"...", "wounds":"...", "leadership":"...", "oc":"...", "invulnerable_save":"... or null"},
 "weapons": [{"name":"...", "type":"Ranged or Melee", "range":"...", "attacks":"...", "skill":"...", "strength":"...", "ap":"...", "damage":"...", "abilities":"weapon special rules, short"}]
}
Do not include unit_composition, abilities, or keyword lists — they aren't needed for this quick check. If the unit cannot be confidently found, instead respond with ONLY: {"error": "explanation"}. Do not include anything outside the JSON object.`;

  const fullPrompt = `Search Wahapedia.com for the current Warhammer 40,000 (10th edition) datasheet for the unit "${unitName}"${faction ? ' from the '+faction+' faction' : ''}. Use the most current points and rules available.
Be efficient, but getting real numbers matters more than saving a search: start with a targeted query like "${unitName} Wahapedia 10th edition datasheet" and use that result if it clearly gives you complete, accurate numbers. Wahapedia's stat table sometimes doesn't appear in a search snippet even though the page has it — if the numeric stat line or weapon profiles are missing or incomplete, don't give up: search again, either rephrased or targeting a plain-text secondary source that quotes the same current official numbers (a community wiki, army-list builder export, or site like Goonhammer). Never fabricate, estimate, or guess a number — only report figures you actually found in a search result. Use up to 3 searches total if needed.
Then respond with ONLY valid JSON, no markdown fences, no preamble, in exactly this shape:
{
 "unit_name": "...",
 "faction": "...",
 "points": "e.g. 80 pts (5 models)",
 "unit_composition": "short plain text",
 "stats": {"movement":"...", "toughness":"...", "save":"...", "wounds":"...", "leadership":"...", "oc":"...", "invulnerable_save":"... or null"},
 "weapons": [{"name":"...", "type":"Ranged or Melee", "range":"...", "attacks":"...", "skill":"...", "strength":"...", "ap":"...", "damage":"...", "abilities":"weapon special rules, short"}],
 "abilities": [{"name":"...", "description":"paraphrased in your own words, one to two sentences, do not quote official rule text verbatim"}],
 "keywords": ["..."],
 "faction_keywords": ["..."]
}
If the unit cannot be confidently found, instead respond with ONLY: {"error": "explanation"}. Paraphrase all rules text — never copy Games Workshop's wording directly. Do not include anything outside the JSON object.`;

  try{
    const data = await callGemini({
      contents: [{ role: 'user', parts: [{ text: isLight ? lightPrompt : fullPrompt }] }],
      generationConfig: { maxOutputTokens: isLight ? 1300 : 1800 },
      tools: [{ google_search: {} }],
    });

    const text = extractText(data);
    const parsed = parseJsonLoose(text);

    if(parsed.error){
      throw new Error(parsed.error);
    }

    if(isLight){
      renderConfirm(parsed);
    } else {
      renderDatasheet(parsed);
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
function renderDatasheet(d){
  setStatus('', 'LINK ESTABLISHED');

  const abilitiesHtml = (d.abilities||[]).map(a=>`
    <div class="abilityItem">
      <div class="abilityName">${escapeHtml(a.name||'')}</div>
      <div class="abilityDesc">${escapeHtml(a.description||'')}</div>
    </div>
  `).join('') || `<div class="loadSub">No special abilities listed.</div>`;

  const keywordChips = (d.keywords||[]).map(k=>`<span class="chip">${escapeHtml(k)}</span>`).join('');
  const factionChips = (d.faction_keywords||[]).map(k=>`<span class="chip">${escapeHtml(k)}</span>`).join('');

  main.innerHTML = `
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

      <div class="noteBox">Rules paraphrased from current Wahapedia listings. Always confirm against your army's official app or GW source before a tournament.</div>
    </div>
  `;

  footer.style.display = 'flex';
  footer.innerHTML = `
    <button class="btn ghost" id="homeFromSheet">🏠 Home</button>
    <button class="btn ghost" id="scanAgain">📷 Rescan</button>
    <button class="btn gold" id="searchAnother">🔎 Other</button>
  `;
  document.getElementById('homeFromSheet').onclick = renderHome;
  document.getElementById('scanAgain').onclick = openCamera;
  document.getElementById('searchAnother').onclick = renderManualSearch;
}

function escapeHtml(str){
  if(str===undefined || str===null) return '';
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// init
renderHome();
