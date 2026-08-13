# Setup: Cloudflare Worker + GitHub Pages

Auspex Scanner needs three things before it's a real, working, installable
app: an Anthropic API key, a small Cloudflare Worker that holds that key and
proxies requests (so the browser never sees it), and GitHub Pages wired up
the same way as Dinner Bell / In Stock. Do these in order.

## 1. Get an Anthropic API key

1. Go to the [Anthropic Console](https://console.anthropic.com) → **API Keys**.
2. Create a key. Add credits/billing if you haven't already — this app's
   usage (a handful of vision + web-search calls per scan) is cheap, but not
   free.

## 2. Deploy the Cloudflare Worker

The worker lives in this repo's `worker/` directory. It's a thin proxy: the
app sends it a request, it adds your API key, forwards to Anthropic, and
returns the response — restricted by CORS to your app's own origin so a
random site can't ride on your key.

1. Free Cloudflare account at [cloudflare.com](https://dash.cloudflare.com/sign-up)
   if you don't have one.
2. Install Wrangler (Cloudflare's CLI) and log in:
   ```sh
   npm install -g wrangler
   wrangler login
   ```
3. From the `worker/` directory, deploy:
   ```sh
   cd worker
   wrangler deploy
   ```
   Wrangler prints a URL like `https://warcamera-proxy.<your-subdomain>.workers.dev`.
   **Copy it** — you'll need it in step 4.
4. Set your Anthropic key as a secret on the worker (never put it in
   `wrangler.toml` or any committed file):
   ```sh
   wrangler secret put ANTHROPIC_API_KEY
   ```
   Paste the key from step 1 when prompted.

`worker/wrangler.toml` already restricts allowed browser origins to
`https://warcamera.mattsapps.xyz` and `http://localhost:5173` (for local
dev). If you rename the subdomain, update `ALLOWED_ORIGINS` there and
redeploy (`wrangler deploy`).

## 3. Point the app at the worker

The app reads the worker URL from a build-time env var, `VITE_WORKER_URL`.

**For the deployed site:** GitHub repo → **Settings → Secrets and variables →
Actions → Variables tab → New repository variable**:
- Name: `WORKER_URL`
- Value: the `https://....workers.dev` URL from step 2.3

(It's a plain repo *variable*, not a secret — the worker URL itself isn't
sensitive, only the API key behind it is.)

**For local development**, create `.env.local` in the repo root (already
gitignored):
```
VITE_WORKER_URL=https://warcamera-proxy.<your-subdomain>.workers.dev
```

## 4. GitHub Pages

1. Repo → **Settings → Pages** → **Source: GitHub Actions**.
2. Same page, **Custom domain**: `warcamera.mattsapps.xyz` → Save.
3. Push to `main` (or re-run the "Deploy to GitHub Pages" workflow) — it
   builds with `VITE_WORKER_URL` baked in and deploys.

## 5. DNS

At your DNS provider for `mattsapps.xyz`, add:

| Type  | Name        | Value                       |
|-------|-------------|------------------------------|
| CNAME | `warcamera` | `fattymatty007.github.io`   |

## 6. Add it to the launcher

In the `mattsapps` repo's `index.html`, add a card to the `APPS` array:

```js
{
  name: 'Auspex Scanner',
  url: 'https://warcamera.mattsapps.xyz',
  tagline: 'Scan a mini, get its datasheet',
},
```

Commit and push — the landing page redeploys automatically.

## Done

Visit `warcamera.mattsapps.xyz`, allow camera access, and scan a miniature.
On mobile, "Add to Home Screen" (Safari) or the install prompt (Chrome)
installs it as a standalone app.
