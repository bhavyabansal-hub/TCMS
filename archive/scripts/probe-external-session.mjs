#!/usr/bin/env node
/* External-URL session probe — proves the exact browser flow that triggers
 * the "Can't reach the server" banner works through the PUBLIC preview URL.
 * Steps: login (sets cookies) -> session check -> refresh POST with ONLY the
 * refresh cookie + Origin header (the exact call the client auto-retries). */
const BASE = 'https://preview-chat-83c513a6-a34e-4429-9baf-148d9774823e.space-z.ai';
const ORIGIN = BASE; // browser Origin == the page URL origin

function cookieOf(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return raw.map((c) => c.split(';')[0]).join('; ');
}

async function main() {
  // 1) LOGIN through the external URL with browser-like headers
  const loginRes = await fetch(`${BASE}/api/auth?path=login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
      'X-Requested-With': 'tcms',
      Referer: `${BASE}/login`,
    },
    body: JSON.stringify({ email: 'admin@tcms.com', password: 'Admin@123' }),
  });
  const loginCookies = cookieOf(loginRes);
  const loginBody = await loginRes.text();
  console.log('LOGIN ', loginRes.status, loginCookies ? '(cookies set)' : '(NO COOKIES)', loginBody.slice(0, 120));
  if (loginRes.status !== 200) { console.log('FAIL at login'); process.exit(1); }

  // 2) SESSION check with access cookie
  const sesRes = await fetch(`${BASE}/api/auth?path=session`, {
    headers: { Cookie: loginCookies, Origin: ORIGIN, 'X-Requested-With': 'tcms' },
  });
  console.log('SESSION', sesRes.status, (await sesRes.text()).slice(0, 100));

  // 3) REFRESH with ONLY the refresh cookie (client strips access cookie when it 401s)
  const refreshOnly = loginCookies.split('; ').filter((c) => c.startsWith('tcms-refresh=')).join('; ');
  const refRes = await fetch(`${BASE}/api/auth?path=refresh`, {
    method: 'POST',
    headers: { Cookie: refreshOnly, Origin: ORIGIN, 'X-Requested-With': 'tcms' },
  });
  console.log('REFRESH', refRes.status, (await refRes.text()).slice(0, 100));
  if (refRes.status !== 200) { console.log('FAIL at refresh — banner WILL appear'); process.exit(1); }

  console.log('ALL GREEN: login + session + refresh all pass through the preview URL.');
}

main().catch((e) => { console.error('probe error:', e.message); process.exit(1); });
