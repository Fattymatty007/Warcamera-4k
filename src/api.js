// All Gemini API calls go through a small Cloudflare Worker proxy (see
// /worker) rather than generativelanguage.googleapis.com directly. Shipping
// a raw API key in client code would let anyone visiting the site burn
// through your free-tier quota (or spend your money once it's exhausted).
// The worker holds the key as a server-side secret and forwards requests.
//
// Set VITE_WORKER_URL at build time (see SETUP.md) to your deployed
// worker's URL, e.g. https://warcamera-proxy.your-subdomain.workers.dev
const WORKER_URL = import.meta.env.VITE_WORKER_URL || '';

export async function callGemini(body) {
  if (!WORKER_URL) {
    throw new Error('Scanner is not configured — no worker URL set (see SETUP.md)');
  }
  const res = await fetch(WORKER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error('API error ' + res.status);
  }
  return res.json();
}
