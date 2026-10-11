// Custom-model library persistence — real browser localStorage.
// (The original prototype used a claude.ai-artifact-only `window.storage`
// API, which doesn't exist outside that sandbox.)

const KEY = 'warcamera-custom-models';

export async function loadCustomModels() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('Failed to load custom models', e);
    return [];
  }
}

export async function saveCustomModelsList(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch (e) {
    console.error('Failed to save custom models', e);
  }
}

// Optional per-visitor Gemini API key — lets someone use their own free
// quota instead of the shared worker owner's. Stored only on this device.
const API_KEY_KEY = 'warcamera-user-api-key';

export async function loadUserApiKey() {
  try {
    return localStorage.getItem(API_KEY_KEY) || '';
  } catch (e) {
    console.error('Failed to load user API key', e);
    return '';
  }
}

export async function saveUserApiKey(key) {
  try {
    if (key) localStorage.setItem(API_KEY_KEY, key);
    else localStorage.removeItem(API_KEY_KEY);
  } catch (e) {
    console.error('Failed to save user API key', e);
  }
}

// Battles — each tracks two rosters (yours vs your opponent's) of scanned
// units for one game, so any datasheet can be reopened without rescanning.
const BATTLES_KEY = 'warcamera-battles';

export async function loadBattles() {
  try {
    const raw = localStorage.getItem(BATTLES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('Failed to load battles', e);
    return [];
  }
}

export async function saveBattlesList(list) {
  try {
    localStorage.setItem(BATTLES_KEY, JSON.stringify(list));
  } catch (e) {
    console.error('Failed to save battles', e);
  }
}

// A personal library of full datasheets, independent of any single battle —
// save a scan once, then reopen it or drop it into any battle roster later
// without rescanning the same physical miniature again.
const COLLECTION_KEY = 'warcamera-collection';

export async function loadCollection() {
  try {
    const raw = localStorage.getItem(COLLECTION_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('Failed to load collection', e);
    return [];
  }
}

export async function saveCollectionList(list) {
  try {
    localStorage.setItem(COLLECTION_KEY, JSON.stringify(list));
  } catch (e) {
    console.error('Failed to save collection', e);
  }
}

// Last meaningful screen shown — so relaunching the app (Android killing
// the backgrounded PWA's process, a screen-lock teardown, or the service
// worker's update reload) returns to the screen the user was on instead
// of resetting to Home. Only a small descriptor is stored ({screen,
// battleId, tab}), never screen content.
const NAV_STATE_KEY = 'warcamera-nav-state';

export function loadNavState() {
  try {
    const raw = localStorage.getItem(NAV_STATE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

export function saveNavState(state) {
  try {
    if (state) localStorage.setItem(NAV_STATE_KEY, JSON.stringify(state));
    else localStorage.removeItem(NAV_STATE_KEY);
  } catch (e) {
    console.error('Failed to save nav state', e);
  }
}
