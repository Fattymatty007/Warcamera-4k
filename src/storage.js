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
