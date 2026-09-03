// All Gemini API calls go through a small Cloudflare Worker proxy (see
// /worker) rather than generativelanguage.googleapis.com directly. Shipping
// a raw API key in client code would let anyone visiting the site burn
// through your free-tier quota (or spend your money once it's exhausted).
// The worker holds the key as a server-side secret and forwards requests.
//
// Set VITE_WORKER_URL at build time (see SETUP.md) to your deployed
// worker's URL, e.g. https://warcamera-proxy.your-subdomain.workers.dev
import { loadUserApiKey } from './storage.js';

const WORKER_URL = import.meta.env.VITE_WORKER_URL || '';

export async function callGemini(body, { model } = {}) {
  if (!WORKER_URL) {
    throw new Error('Scanner is not configured — no worker URL set (see SETUP.md)');
  }
  // If the visitor has entered their own Gemini key (see "Use My Own API
  // Key" in Settings), send it along — the worker uses it instead of its
  // own secret for this request, so their usage draws from their own free
  // tier rather than the worker owner's.
  const userKey = await loadUserApiKey();
  const headers = { 'Content-Type': 'application/json' };
  if (userKey) headers['X-Gemini-User-Key'] = userKey;
  // Optional per-call model override (see main.js) — e.g. the faster/
  // cheaper Flash-Lite tier for text-only datasheet lookups, vs. the
  // default for vision identification. Falls back to the worker's own
  // default model when omitted.
  if (model) headers['X-Gemini-Model'] = model;

  const res = await fetch(WORKER_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Surface Gemini's actual error message (e.g. "model overloaded" vs
    // "quota exceeded") instead of just the status code — the two need
    // very different fixes and the code alone doesn't distinguish them.
    let detail = '';
    try {
      const errJson = await res.json();
      detail = errJson?.error?.message || '';
    } catch (e) { /* body wasn't JSON — fall back to bare status */ }
    // The worker already retries once on a 429 before giving up (see
    // worker/src/index.js), so a 429 reaching here means that retry didn't
    // clear it — most often a free-tier key's per-minute limit, which is
    // much tighter than the shared/billed worker key's. Call this out
    // specifically for a visitor's own key, since "API error 429" alone
    // reads like the app is broken rather than a quota they can just wait out.
    if (res.status === 429) {
      throw new Error(
        (userKey ? 'Your API key' : 'This key') +
        ' hit Google’s rate limit' + (detail ? ' (' + detail + ')' : '') +
        ' — free-tier keys allow only a few requests per minute. Wait a bit and try again.'
      );
    }
    throw new Error('API error ' + res.status + (detail ? ': ' + detail : ''));
  }
  return res.json();
}
