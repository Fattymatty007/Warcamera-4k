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

export async function callGemini(body) {
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
    throw new Error('API error ' + res.status + (detail ? ': ' + detail : ''));
  }
  return res.json();
}
