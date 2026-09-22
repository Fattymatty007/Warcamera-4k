// licenseClient.js — Matt's Apps membership license check.
//
// How it works: when someone buys the All-Access Membership, Lemon Squeezy
// emails them a license key. This module validates that key against Lemon
// Squeezy's public license API (no secret needed) and remembers it in
// localStorage, so members only enter it once per app.
//
// TODO: replace CHECKOUT_URL with the direct checkout link once the
// "All-Access Membership" product is published in Lemon Squeezy. Until then
// it points at the store page, which lists the product once it's live.

export const CHECKOUT_URL = 'https://mattsapps.lemonsqueezy.com';

const VALIDATE_URL = 'https://api.lemonsqueezy.com/v1/licenses/validate';
const LS_KEY = 'mattsapps_license_key';
const LS_OK_AT = 'mattsapps_license_validated_at';

export function getSavedKey() {
  try {
    return (localStorage.getItem(LS_KEY) || '').trim();
  } catch (e) {
    return '';
  }
}

function rememberKey(key) {
  try {
    localStorage.setItem(LS_KEY, key);
    localStorage.setItem(LS_OK_AT, String(Date.now()));
  } catch (e) {
    /* storage unavailable — key just won't persist */
  }
}

export function forgetKey() {
  try {
    localStorage.removeItem(LS_KEY);
    localStorage.removeItem(LS_OK_AT);
  } catch (e) {
    /* ignore */
  }
}

function wasPreviouslyValidated() {
  try {
    return !!localStorage.getItem(LS_OK_AT);
  } catch (e) {
    return false;
  }
}

// Validate a license key with Lemon Squeezy.
// Returns { ok: true } or { ok: false, error: 'message' }.
export async function validateLicenseKey(rawKey) {
  const key = (rawKey || '').trim();
  if (!key) return { ok: false, error: 'Enter your license key.' };

  let res;
  try {
    res = await fetch(VALIDATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ license_key: key }),
    });
  } catch (e) {
    // Network failure (offline, blocked, etc.): honor a previously validated
    // key so paying members aren't locked out by a connection blip.
    if (wasPreviouslyValidated()) return { ok: true, offline: true };
    return { ok: false, error: "Couldn't reach the license server. Check your connection and try again." };
  }

  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    data = null;
  }

  const valid =
    res.ok &&
    !!data &&
    !data.errors &&
    (data?.meta?.valid === true || data?.license_key?.status === 'active' || !!data?.license_key);

  if (valid) {
    rememberKey(key);
    return { ok: true };
  }
  return {
    ok: false,
    error: "That key didn't check out. Check for typos, or grab a fresh one from your receipt email.",
  };
}

// True when a saved key exists and still validates (re-validates every launch,
// so cancelled memberships lose access).
export async function hasValidLicense() {
  const key = getSavedKey();
  if (!key) return false;
  const result = await validateLicenseKey(key);
  return result.ok;
}
