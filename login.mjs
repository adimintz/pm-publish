// The sign-in page every prototype is published behind. The prototype rides inside it as base64 and
// replaces the page only after Supabase accepts the email and password; a floating button signs out.
// Users live in VO's Supabase project, the same one VO's own login uses.
// shortcut: the prototype is still readable in the page source, so this keeps casual visitors out but
// doesn't make the content secret. Encrypting the payload (or serving it from Supabase) is the next step.

export const SUPABASE_URL = 'https://swkryteuvqmthtyxgspa.supabase.co';
// The public anon key: it only lets a browser call Supabase's sign-in, and VO's built app already ships it.
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN3a3J5dGV1dnFtdGh0eXhnc3BhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxOTU0MDQsImV4cCI6MjA4Nzc3MTQwNH0.Bbo2Wvv3lu8Fnfad1ZJDF_VTPB-hxuELmNI2CePjJ4c';

export function loginPage({ html, supabaseUrl = SUPABASE_URL, anonKey = SUPABASE_ANON_KEY }) {
  const payload = Buffer.from(html, 'utf8').toString('base64');
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
  <label>Email <input id="email" type="email" autocomplete="username" required></label>
  <label>Password <input id="password" type="password" autocomplete="current-password" required></label>
  <button id="submit" type="submit">Sign in</button>
  <p id="error" role="alert"></p>
</form>
<script id="prototype" type="application/octet-stream">${payload}</script>
<script>
(() => {
  const SUPABASE_URL = ${JSON.stringify(supabaseUrl)};
  const ANON_KEY = ${JSON.stringify(anonKey)};
  const STORE = 'prototype-session';
  const form = document.getElementById('login');
  const error = document.getElementById('error');
  const submit = document.getElementById('submit');

  const load = () => { try { return JSON.parse(localStorage.getItem(STORE)); } catch { return null; } };
  const save = (s) => { try { localStorage.setItem(STORE, JSON.stringify({ access_token: s.access_token, refresh_token: s.refresh_token })); } catch {} };
  const clear = () => { try { localStorage.removeItem(STORE); } catch {} };

  async function auth(path, { body, token } = {}) {
    const res = await fetch(SUPABASE_URL + '/auth/v1/' + path, {
      method: body ? 'POST' : 'GET',
      headers: { apikey: ANON_KEY, 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  }

  function show() {
    const bytes = Uint8Array.from(atob(document.getElementById('prototype').textContent.trim()), (c) => c.charCodeAt(0));
    const html = new TextDecoder().decode(bytes);
    document.open();
    document.write(html);
    document.close();
    addSignOut();
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
    button.addEventListener('click', async () => {
      button.disabled = true;
      const token = load()?.access_token;
      // Revokes the refresh token on Supabase; signing out locally still happens if this fails.
      if (token) await auth('logout', { body: {}, token }).catch(() => {});
      clear();
      location.reload();
    });
    host.attachShadow({ mode: 'open' }).append(style, button);
    document.body.appendChild(host);
  }

  // A stored session skips the form: check it, refresh it once if it expired, otherwise ask again.
  async function resume() {
    const session = load();
    if (session?.access_token && (await auth('user', { token: session.access_token })).ok) return true;
    if (session?.refresh_token) {
      const refreshed = await auth('token?grant_type=refresh_token', { body: { refresh_token: session.refresh_token } });
      if (refreshed.ok) { save(refreshed.data); return true; }
    }
    clear();
    return false;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    submit.disabled = true;
    try {
      const { ok, data } = await auth('token?grant_type=password', {
        body: { email: document.getElementById('email').value.trim(), password: document.getElementById('password').value },
      });
      if (ok) { save(data); show(); return; }
      error.textContent = data.error_description || data.msg || 'Wrong email or password.';
    } catch {
      error.textContent = "Can't reach the sign-in service. Try again.";
    }
    submit.disabled = false;
  });

  resume().then((ok) => (ok ? show() : (form.hidden = false)), () => (form.hidden = false));
})();
</script>
</body>
</html>
`;
}
