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
