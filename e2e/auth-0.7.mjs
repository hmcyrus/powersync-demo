import { execSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = 'http://127.0.0.1';
const SYNC = 'http://127.0.0.1';

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function pass(message) {
  console.log(`PASS: ${message}`);
}

function psql(sql) {
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  execSync(`docker compose exec -T postgres psql -U postgres -d postgres -c "${oneLine}"`, {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

function loopbackUrl(url) {
  const parsed = new URL(url);
  if (parsed.hostname.endsWith('.localhost')) {
    parsed.hostname = '127.0.0.1';
  }
  return parsed.href;
}

function virtualHost(url) {
  const host = new URL(url).hostname;
  if (host === '127.0.0.1' || host === 'localhost') {
    return 'app.localhost';
  }
  return host;
}

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(loopbackUrl(url));
    const payload = body ? Buffer.from(body, 'utf8') : null;
    const reqHeaders = {
      ...headers,
      host: headers.host || headers.Host || virtualHost(url),
    };
    if (payload && !reqHeaders['content-length']) {
      reqHeaders['content-length'] = String(payload.length);
    }

    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method,
        headers: reqHeaders,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text,
          });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function mergeCookies(existing, setCookieHeader) {
  const rawValues = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : setCookieHeader
      ? [setCookieHeader]
      : [];
  let cookieHeader = existing;
  for (const raw of rawValues) {
    const part = raw.split(';')[0];
    if (!cookieHeader.includes(part)) {
      cookieHeader = cookieHeader ? `${cookieHeader}; ${part}` : part;
    }
  }
  return cookieHeader;
}

async function fetchJson(url, init = {}) {
  const res = await request(url, init);
  return { res, json: parseJson(res.text), text: res.text };
}

async function followAuthRedirects(startUrl) {
  let cookieHeader = '';
  let url = loopbackUrl(startUrl);
  for (let hop = 0; hop < 8; hop += 1) {
    const res = await request(url, {
      headers: cookieHeader ? { Cookie: cookieHeader } : {},
    });
    cookieHeader = mergeCookies(cookieHeader, res.headers['set-cookie']);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.location;
      if (!location) fail(`redirect without location from ${url}`);
      url = loopbackUrl(new URL(location, url).href);
      continue;
    }
    return { res, cookieHeader };
  }
  fail('too many OIDC redirects');
}

psql("INSERT INTO allowed_emails (email) VALUES ('doctor@example.com') ON CONFLICT (email) DO NOTHING;");

const jwks = await fetchJson(`${APP}/api/.well-known/jwks.json`);
if (jwks.res.status !== 200 || !jwks.json?.keys?.length) {
  fail(`JWKS via Caddy: status ${jwks.res.status} body ${jwks.text.slice(0, 120)}`);
}
if (jwks.json.keys[0].kty !== 'RSA' || !jwks.json.keys[0].kid) {
  fail('JWKS missing RSA public key with kid');
}
pass('Caddy routes app.localhost/api to JWKS');

const oidc = await fetchJson(`${APP}/api/oidc/.well-known/openid-configuration`);
if (oidc.res.status !== 200 || !oidc.json?.authorization_endpoint) {
  fail(`stub OIDC discovery failed: status ${oidc.res.status}`);
}
pass('stub OIDC discovery reachable via Caddy');

const login = await followAuthRedirects(
  `${APP}/api/auth/oidc/start?email=doctor@example.com`,
);
if (!login.cookieHeader.includes('poc_session=')) {
  fail('OIDC start/callback did not set poc_session cookie');
}
pass('stub OIDC start/callback sets session cookie');
const sessionCookie = login.cookieHeader;

const deviceId = `e2e-device-${Date.now()}`;
const register = await fetchJson(`${APP}/api/devices/register`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Cookie: sessionCookie,
  },
  body: JSON.stringify({ id: deviceId, name: 'e2e-0.7' }),
});
if (register.res.status !== 200 || register.json?.slot == null) {
  fail(`device register failed: status ${register.res.status} body ${register.text}`);
}
pass('POST /devices/register assigns slot via Caddy');

const tokenRes = await fetchJson(
  `${APP}/api/sync/token?device_id=${encodeURIComponent(deviceId)}`,
  { headers: { Cookie: sessionCookie } },
);
if (tokenRes.res.status !== 200 || !tokenRes.json?.token) {
  fail(`GET /sync/token failed: status ${tokenRes.res.status} body ${tokenRes.text}`);
}
pass('GET /sync/token returns JWT for registered device');

const todoId = `00000000-0000-4000-8000-${String(Date.now()).slice(-12)}`;
const upload = await fetchJson(`${APP}/api/sync/upload`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${tokenRes.json.token}`,
  },
  body: JSON.stringify({
    batch: [
      {
        op: 'PUT',
        table: 'todos',
        id: todoId,
        opData: {
          title: 'auth-0.7 upload',
          is_completed: 0,
          created_at: new Date().toISOString(),
        },
      },
    ],
  }),
});
if (upload.res.status !== 200 || upload.json?.ok !== true || upload.json?.applied !== true) {
  fail(`POST /sync/upload failed: status ${upload.res.status} body ${upload.text}`);
}
pass('POST /sync/upload applies batch with bearer JWT');

const cors = await request(`${SYNC}/sync/stream`, {
  method: 'OPTIONS',
  headers: {
    host: 'sync.localhost',
    Origin: 'http://app.localhost',
    'Access-Control-Request-Method': 'GET',
  },
});
const allowOrigin = cors.headers['access-control-allow-origin'];
if (cors.status !== 204 || !allowOrigin) {
  fail(`PowerSync CORS preflight failed: status ${cors.status} allow-origin=${allowOrigin}`);
}
if (allowOrigin !== 'http://app.localhost' && allowOrigin !== '*') {
  fail(`PowerSync CORS origin unexpected: ${allowOrigin}`);
}
pass('sync.localhost CORS allows app.localhost');

console.log('auth-0.7: all checks passed');
process.exit(0);
