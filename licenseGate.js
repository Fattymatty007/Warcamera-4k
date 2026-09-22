// licenseGate.js — vanilla-JS membership gate for WarCamera 4k.
//
// requireLicense(appName) returns a Promise that resolves once the visitor
// has a valid Matt's Apps license key. Call it before rendering anything:
//
//   import { requireLicense } from './licenseGate.js';
//   requireLicense('WarCamera 4k').then(() => { renderHome(); });
//
// Members enter the license key from their Lemon Squeezy receipt email once;
// it's remembered in localStorage afterwards.

import { getSavedKey, validateLicenseKey, CHECKOUT_URL } from './licenseClient.js';

const STYLES = `
  #license-gate-overlay{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;background:#0b0a08;font-family:Inter,system-ui,-apple-system,sans-serif;box-sizing:border-box}
  #license-gate-overlay *{box-sizing:border-box}
  .lg-card{width:100%;max-width:380px;background:#14120e;border:1px solid #2e2a20;border-radius:16px;padding:28px;text-align:center;color:#f2efe6}
  .lg-kicker{font-size:11px;letter-spacing:.18em;color:#c9a227;margin-bottom:10px;font-weight:600}
  .lg-title{font-size:22px;font-weight:700;margin-bottom:10px}
  .lg-body{font-size:14px;line-height:1.55;color:#c9c6ba;margin:0 0 18px}
  .lg-form{display:flex;flex-direction:column;gap:10px;margin-bottom:12px}
  .lg-input{padding:12px 14px;font-size:15px;border-radius:10px;border:1px solid #3a352a;background:#0e0d0a;color:#f2efe6;outline:none;text-align:center;font-family:ui-monospace,monospace}
  .lg-button{padding:12px 14px;font-size:15px;font-weight:600;border-radius:10px;border:none;background:#c9a227;color:#1c1e19;cursor:pointer}
  .lg-button:disabled{opacity:.6;cursor:wait}
  .lg-error{font-size:13px;color:#e08080;margin-bottom:12px;line-height:1.5}
  .lg-muted{font-size:13px;color:#8b9a7d}
  .lg-muted a{color:#c9a227;font-weight:600}
`;

function buildOverlay(appName) {
  const style = document.createElement('style');
  style.textContent = STYLES;
  document.head.appendChild(style);

  const overlay = document.createElement('div');
  overlay.id = 'license-gate-overlay';
  overlay.innerHTML =
    '<div class="lg-card">' +
      '<div class="lg-kicker">MATT\u2019S APPS \u00b7 MEMBERS</div>' +
      '<div class="lg-title">' + appName + ' is for members</div>' +
      '<p class="lg-body">This app is part of the Matt\u2019s Apps all-access membership. ' +
      'Enter the license key from your receipt email to unlock it \u2014 you only do this once.</p>' +
      '<form class="lg-form" id="lg-form">' +
        '<input class="lg-input" id="lg-key" placeholder="XXXXXX-XXXXXX-XXXXXX-XXXXXX" ' +
          'autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" />' +
        '<button class="lg-button" id="lg-submit" type="submit">Unlock app</button>' +
      '</form>' +
      '<div class="lg-error" id="lg-error" style="display:none"></div>' +
      '<div class="lg-muted">No key yet? <a href="' + CHECKOUT_URL + '">Become a member</a></div>' +
    '</div>';
  document.body.appendChild(overlay);
  return overlay;
}

export function requireLicense(appName) {
  return new Promise((resolve) => {
    const done = () => {
      const el = document.getElementById('license-gate-overlay');
      if (el) el.remove();
      resolve();
    };

    // Fast path: a saved key that still validates unlocks without the form.
    (async () => {
      const saved = getSavedKey();
      if (saved) {
        const r = await validateLicenseKey(saved);
        if (r.ok) {
          done();
          return;
        }
      }
      const overlay = buildOverlay(appName);
      const form = overlay.querySelector('#lg-form');
      const input = overlay.querySelector('#lg-key');
      const submitBtn = overlay.querySelector('#lg-submit');
      const errorBox = overlay.querySelector('#lg-error');

      // Show the form immediately while the saved-key check ran above.
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        submitBtn.disabled = true;
        submitBtn.textContent = 'Checking\u2026';
        errorBox.style.display = 'none';
        const r = await validateLicenseKey(input.value);
        if (r.ok) {
          done();
        } else {
          errorBox.textContent = r.error;
          errorBox.style.display = 'block';
          submitBtn.disabled = false;
          submitBtn.textContent = 'Unlock app';
        }
      });
    })();
  });
}
