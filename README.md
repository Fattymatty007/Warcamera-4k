# Auspex Scanner (WarCamera 4K)

Point your camera at a Warhammer 40,000 miniature, get an AI best-guess at
which unit it is, then pull that unit's current stat line, weapons, and
abilities from Wahapedia. Installable as a PWA — "Add to Home Screen" gets
you an app icon and a standalone (no browser chrome) window.

Hosted the same way as [Dinner Bell](https://github.com/Fattymatty007/dinner-bell)
and [In Stock](https://github.com/Fattymatty007/In-Stock): a static Vite build
deployed to GitHub Pages under its own `mattsapps.xyz` subdomain, linked from
the [mattsapps](https://github.com/Fattymatty007/mattsapps) launcher.

Unlike those two, this app calls the Claude API (vision to identify the
miniature, web search to pull the datasheet) — see [SETUP.md](SETUP.md) for
the one-time Cloudflare Worker deploy that makes that possible without
shipping an API key to the browser.

## Local development

```sh
npm install
npm run dev
```

Camera access requires HTTPS or `localhost` — `npm run dev` serves on
`localhost`, so that's covered. Without a deployed worker (see SETUP.md) and
a local `.env.local` pointing `VITE_WORKER_URL` at it, scanning and datasheet
lookups will fail — everything else in the UI still renders.
