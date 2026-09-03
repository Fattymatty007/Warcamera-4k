// Cloudflare Worker proxy for the Gemini API.
//
// The app (a static site) can't call generativelanguage.googleapis.com
// directly with an embedded key — anyone visiting the site could read it out
// of the JS bundle and spend your free-tier quota (or your money, if it's
// exhausted). This worker holds the key as a server-side secret and forwards
// requests, restricting browser callers to the app's own origin via CORS.
//
// A visitor can optionally supply their own Gemini key via the
// X-Gemini-User-Key header (see src/api.js / the in-app "Use My Own API
// Key" setting) — when present it's used instead of the worker's own
// secret, so that visitor's usage draws from their own quota, not the
// worker owner's. Calling Gemini directly from the browser isn't reliable
// (CORS support on generativelanguage.googleapis.com is inconsistent), so
// this still routes through the worker even for a visitor's own key — the
// key is only ever held in memory for the life of this one request, never
// logged or persisted anywhere server-side.
//
// Note: CORS only stops *browser* callers outside the allowed origin —
// someone with the worker URL could still call it directly with curl,
// since Origin isn't enforced for non-browser requests. That's an accepted
// tradeoff for a small personal app with no server-side user accounts; if
// abuse becomes a concern, add a Cloudflare rate-limiting rule on this route.

// `gemini-flash-latest` always points at Google's current default Flash
// model — confirmed against the cURL quickstart Google generates for this
// account's own API key, since a pinned dated model name (e.g.
// gemini-2.5-flash) can 404 once Google retires or renames it. Used as the
// default when a request doesn't specify one via X-Gemini-Model (see
// src/main.js — vision ID uses this default; the lighter/faster
// datasheet-lookup calls request gemini-flash-lite-latest instead).
const DEFAULT_MODEL = 'gemini-flash-latest';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || 'https://warcamera.mattsapps.xyz,http://localhost:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const allowOrigin = allowed.includes(origin) ? origin : allowed[0];

    const corsHeaders = {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Gemini-User-Key, X-Gemini-Model',
      'Vary': 'Origin',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders });
    }

    const apiKey = request.headers.get('X-Gemini-User-Key') || env.GEMINI_API_KEY;

    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'Worker is not configured with an API key (missing GEMINI_API_KEY secret)' }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
      );
    }

    const body = await request.text();

    // Caller-selected model (see src/main.js) — validated against a strict
    // charset since it goes straight into the URL path, not passed through
    // unchecked. Falls back to the default for anything absent or invalid.
    const requestedModel = request.headers.get('X-Gemini-Model');
    const model = (requestedModel && /^[a-zA-Z0-9_.-]+$/.test(requestedModel)) ? requestedModel : DEFAULT_MODEL;
    const upstreamUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const callUpstream = (sendBody) => fetch(upstreamUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: sendBody,
    });

    let parsedBody;
    try { parsedBody = JSON.parse(body); } catch (e) { parsedBody = null; }
    const hasTools = !!(parsedBody && parsedBody.tools);
    const strippedBody = hasTools ? JSON.stringify((({ tools, ...rest }) => rest)(parsedBody)) : body;
    const isByok = !!request.headers.get('X-Gemini-User-Key');

    // Google Search grounding (see the `tools` param in src/main.js's
    // datasheet-lookup calls, used so stats reflect recent balance updates
    // instead of just the model's training cutoff) requires a billing-
    // enabled Google Cloud project even within free-tier usage volume. A
    // visitor's own key (the whole point of "bring your own key" is a free
    // key with no billing attached) will predictably fail the grounded call
    // and cost a wasted request against their often-tight free-tier rate
    // limit — skip straight to the non-grounded request for BYOK rather
    // than spending that call. The worker owner's own key (assumed billed,
    // since that's what made grounding work at all) still tries grounded
    // first, falling back to non-grounded only if that specific call comes
    // back 429/403.
    let sendBody = (isByok && hasTools) ? strippedBody : body;
    let upstream = await callUpstream(sendBody);

    if (!upstream.ok && (upstream.status === 429 || upstream.status === 403) && hasTools && sendBody === body) {
      sendBody = strippedBody;
      upstream = await callUpstream(sendBody);
    }

    // A 429 can be a transient rate-limit blip rather than a real outage —
    // common right after adding a fresh key and testing it a few times in
    // quick succession, since free-tier keys often allow only a handful of
    // requests per minute. One short retry with the same key/body costs
    // nothing extra (same quota, just delayed) and often succeeds.
    if (!upstream.ok && upstream.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      upstream = await callUpstream(sendBody);
    }

    const respBody = await upstream.text();
    return new Response(respBody, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  },
};
