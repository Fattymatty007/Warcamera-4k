// Cloudflare Worker proxy for the Gemini API.
//
// The app (a static site) can't call generativelanguage.googleapis.com
// directly with an embedded key — anyone visiting the site could read it out
// of the JS bundle and spend your free-tier quota (or your money, if it's
// exhausted). This worker holds the key as a server-side secret and forwards
// requests, restricting browser callers to the app's own origin via CORS.
//
// Note: CORS only stops *browser* callers outside the allowed origin —
// someone with the worker URL could still call it directly with curl,
// since Origin isn't enforced for non-browser requests. That's an accepted
// tradeoff for a small personal app with no server-side user accounts; if
// abuse becomes a concern, add a Cloudflare rate-limiting rule on this route.

// `gemini-flash-latest` always points at Google's current default Flash
// model — confirmed against the cURL quickstart Google generates for this
// account's own API key, since a pinned dated model name (e.g.
// gemini-2.5-flash) can 404 once Google retires or renames it.
const GEMINI_MODEL = 'gemini-flash-latest';

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
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders });
    }

    if (!env.GEMINI_API_KEY) {
      return new Response(
        JSON.stringify({ error: 'Worker is not configured with an API key (missing GEMINI_API_KEY secret)' }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
      );
    }

    const body = await request.text();

    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': env.GEMINI_API_KEY,
        },
        body,
      },
    );

    const respBody = await upstream.text();
    return new Response(respBody, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  },
};
