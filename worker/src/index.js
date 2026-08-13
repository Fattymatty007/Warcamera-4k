// Cloudflare Worker proxy for the Anthropic API.
//
// The app (a static site) can't call api.anthropic.com directly — browsers
// don't get CORS access to that API, and embedding a raw API key in client
// JS would let anyone visiting the site spend your credits. This worker
// holds the key as a server-side secret and forwards requests, restricting
// browser callers to the app's own origin via CORS.
//
// Note: CORS only stops *browser* callers outside the allowed origin —
// someone with the worker URL could still call it directly with curl,
// since Origin isn't enforced for non-browser requests. That's an accepted
// tradeoff for a small personal app with no server-side user accounts; if
// abuse becomes a concern, add a Cloudflare rate-limiting rule on this route.

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

    if (!env.ANTHROPIC_API_KEY) {
      return new Response(
        JSON.stringify({ error: 'Worker is not configured with an API key (missing ANTHROPIC_API_KEY secret)' }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
      );
    }

    const body = await request.text();

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body,
    });

    const respBody = await upstream.text();
    return new Response(respBody, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  },
};
