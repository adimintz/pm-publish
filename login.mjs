// The locked page every prototype is published behind. The prototype is encrypted with a random key
// (AES-GCM); each user's username and password, stretched with PBKDF2, locks its own copy of that key.
// The page holds only ciphertext: no usernames, no passwords, nothing readable. The browser unlocks it
// with WebCrypto, swaps the prototype in, and adds a floating Sign out button.

const ITERATIONS = 600_000;
const toB64 = (bytes) => Buffer.from(bytes).toString('base64');
const fromB64 = (text) => new Uint8Array(Buffer.from(text, 'base64'));

// userKey, openKey and openContent are shared by the browser (inlined into the page as source) and by
// publish, verify and the tests, so every side locks and opens the page the same way.
async function userKey(subtle, username, password, salt, iterations, usage) {
  const secret = new TextEncoder().encode(`${username.trim().toLowerCase()}\n${password}`);
  const base = await subtle.importKey('raw', secret, 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

// The content key's raw bytes, or null when no user's lock fits these credentials.
async function openKey(subtle, locked, username, password, fromBase64) {
  const key = await userKey(subtle, username, password, fromBase64(locked.salt), locked.iterations, 'decrypt');
  for (const lock of locked.locks) {
    try {
      return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(lock.iv) }, key, fromBase64(lock.key)));
    } catch {
      // Not this user's lock; try the next one.
    }
  }
  return null;
}

async function openContent(subtle, locked, rawKey, fromBase64) {
  const key = await subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(locked.iv) }, key, fromBase64(locked.data));
  return new TextDecoder().decode(plain);
}

async function lock({ html, users }) {
  const { subtle } = globalThis.crypto;
  const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
  const rawKey = random(32);
  const contentKey = await subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const iv = random(12);
  const data = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, contentKey, new TextEncoder().encode(html)));
  const salt = random(16);
  const locks = [];
  for (const { username, password } of users) {
    const key = await userKey(subtle, username, password, salt, ITERATIONS, 'encrypt');
    const lockIv = random(12);
    locks.push({ iv: toB64(lockIv), key: toB64(new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: lockIv }, key, rawKey))) });
  }
  return { iterations: ITERATIONS, salt: toB64(salt), iv: toB64(iv), data: toB64(data), locks };
}

// The locked data inside a published page, or null if the page isn't one.
export function readLocked(page) {
  const match = page.match(/<script id="locked" type="application\/json">([^<]+)<\/script>/);
  return match ? JSON.parse(match[1]) : null;
}

// What verify and the tests use to open a page the way a browser would. Null means wrong credentials.
export async function unlock({ page, username, password }) {
  const locked = readLocked(page);
  const rawKey = locked && await openKey(globalThis.crypto.subtle, locked, username, password, fromB64);
  return rawKey ? openContent(globalThis.crypto.subtle, locked, rawKey, fromB64) : null;
}

export async function lockedPage({ html, users }) {
  if (!users.length) throw new Error('A locked page needs at least one user.');
  const locked = await lock({ html, users });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #f5f5f7; color: #1d1d1f; }
  form { width: min(320px, calc(100vw - 32px)); background: #fff; padding: 28px; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,.08); display: grid; gap: 12px; }
  h1 { margin: 0 0 4px; font-size: 20px; }
  label { display: grid; gap: 4px; font-size: 13px; color: #6e6e73; }
  input { font: inherit; padding: 10px 12px; border: 1px solid #d2d2d7; border-radius: 8px; color: #1d1d1f; }
  button { font: inherit; padding: 10px; border: 0; border-radius: 8px; background: #1d1d1f; color: #fff; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  #error { margin: 0; min-height: 1.2em; font-size: 13px; color: #c62828; }
  [hidden] { display: none; }
</style>
</head>
<body>
<form id="login" hidden>
  <h1>Sign in to view</h1>
  <label>Username <input id="username" autocomplete="username" autocapitalize="none" required></label>
  <label>Password <input id="password" type="password" autocomplete="current-password" required></label>
  <button id="submit" type="submit">Sign in</button>
  <p id="error" role="alert"></p>
</form>
<script id="locked" type="application/json">${JSON.stringify(locked)}</script>
<script>
(() => {
  const STORE = 'prototype-key';
  const locked = JSON.parse(document.getElementById('locked').textContent);
  const subtle = window.crypto && window.crypto.subtle;
  const form = document.getElementById('login');
  const error = document.getElementById('error');
  const submit = document.getElementById('submit');
  const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
  ${userKey.toString()}
  const openKey = ${openKey.toString()};
  const openContent = ${openContent.toString()};

  const loadKey = () => { try { const k = localStorage.getItem(STORE); return k && fromBase64(k); } catch { return null; } };
  const saveKey = (k) => { try { localStorage.setItem(STORE, toBase64(k)); } catch {} };
  const clearKey = () => { try { localStorage.removeItem(STORE); } catch {} };

  function show(html) {
    document.open();
    document.write(html);
    document.close();
    // A prototype that loads a <script src> in its <head> is still being parsed here, with no <body> yet.
    if (document.body) addSignOut();
    else document.addEventListener('DOMContentLoaded', addSignOut, { once: true });
  }

  // Floating button over the prototype. A shadow root keeps the prototype's CSS off it and its CSS off the prototype.
  function addSignOut() {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Sign out';
    const style = document.createElement('style');
    style.textContent = 'button{font:500 13px system-ui,sans-serif;padding:8px 14px;border:0;border-radius:999px;background:#1d1d1f;color:#fff;cursor:pointer;opacity:.55;box-shadow:0 2px 10px rgba(0,0,0,.2);transition:opacity .15s}button:hover,button:focus-visible{opacity:1}';
    button.addEventListener('click', () => { clearKey(); location.reload(); });
    host.attachShadow({ mode: 'open' }).append(style, button);
    document.body.appendChild(host);
  }

  // A key saved by an earlier sign-in skips the form, unless the page was republished with a new key since.
  async function resume() {
    const saved = loadKey();
    if (!saved) return null;
    try { return await openContent(subtle, locked, saved, fromBase64); } catch { clearKey(); return null; }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    submit.disabled = true;
    submit.textContent = 'Checking…';
    try {
      const rawKey = await openKey(subtle, locked, document.getElementById('username').value, document.getElementById('password').value, fromBase64);
      if (rawKey) {
        const html = await openContent(subtle, locked, rawKey, fromBase64);
        saveKey(rawKey);
        show(html);
        return;
      }
      error.textContent = 'Wrong username or password.';
    } catch {
      error.textContent = "This page couldn't be opened. Try again.";
    }
    submit.disabled = false;
    submit.textContent = 'Sign in';
  });

  function start() {
    if (!subtle) {
      form.hidden = false;
      error.textContent = 'This page needs a secure (https) connection to open.';
      submit.disabled = true;
      return;
    }
    resume().then((html) => (html ? show(html) : (form.hidden = false)), () => (form.hidden = false));
  }

  // While this page is still being parsed the browser ignores document.open(), and a saved key opens fast
  // enough to get there first, so wait until parsing is done.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
</script>
</body>
</html>
`;
}
