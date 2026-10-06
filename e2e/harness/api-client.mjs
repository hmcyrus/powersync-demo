import { execSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const APP_BASE = 'http://127.0.0.1';
export const SYNC_ENDPOINT = 'http://127.0.0.1:8080';

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

export function request(url, { method = 'GET', headers = {}, body } = {}) {
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
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
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

export async function fetchJson(url, init = {}) {
  const res = await request(url, init);
  return { res, json: parseJson(res.text), text: res.text };
}

export async function followAuthRedirects(startUrl) {
  let cookieHeader = '';
  let url = loopbackUrl(startUrl);
  for (let hop = 0; hop < 8; hop += 1) {
    const res = await request(url, {
      headers: cookieHeader ? { Cookie: cookieHeader } : {},
    });
    cookieHeader = mergeCookies(cookieHeader, res.headers['set-cookie']);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.location;
      if (!location) throw new Error(`redirect without location from ${url}`);
      url = loopbackUrl(new URL(location, url).href);
      continue;
    }
    return { res, cookieHeader };
  }
  throw new Error('too many OIDC redirects');
}

export async function signIn(email = 'doctor@example.com') {
  const login = await followAuthRedirects(
    `${APP_BASE}/api/auth/oidc/start?email=${encodeURIComponent(email)}`,
  );
  if (!login.cookieHeader.includes('poc_session=')) {
    throw new Error('OIDC start/callback did not set poc_session cookie');
  }
  return login.cookieHeader;
}

export async function registerDevice(sessionCookie, { deviceId, name }) {
  const register = await fetchJson(`${APP_BASE}/api/devices/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie,
    },
    body: JSON.stringify({ id: deviceId, name }),
  });
  if (register.res.status !== 200 || register.json?.slot == null) {
    throw new Error(`device register failed: status ${register.res.status} body ${register.text}`);
  }
  return register.json;
}

export async function listDevices(sessionCookie) {
  const res = await fetchJson(`${APP_BASE}/api/devices`, {
    headers: { Cookie: sessionCookie },
  });
  if (res.res.status !== 200 || !Array.isArray(res.json)) {
    throw new Error(`GET /devices failed: status ${res.res.status} body ${res.text}`);
  }
  return res.json;
}

export async function deleteDevice(sessionCookie, deviceId) {
  const res = await fetchJson(`${APP_BASE}/api/devices/${encodeURIComponent(deviceId)}`, {
    method: 'DELETE',
    headers: { Cookie: sessionCookie },
  });
  if (res.res.status !== 200) {
    throw new Error(`DELETE /devices/${deviceId} failed: status ${res.res.status} body ${res.text}`);
  }
}

function psql(sql) {
  runPsql(sql);
}

export function runPsql(sql) {
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  execSync(`docker compose exec -T postgres psql -U postgres -d postgres -c "${oneLine}"`, {
    cwd: ROOT,
    stdio: 'pipe',
  });
}

export function psqlQuery(sql) {
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  const out = execSync(
    `docker compose exec -T postgres psql -U postgres -d postgres -t -A -c "${oneLine}"`,
    { cwd: ROOT, encoding: 'utf8' },
  ).trim();
  if (!out) return [];
  return JSON.parse(out);
}

/** Free slots: hard-delete revoked and prior test/harness rows (soft revoke keeps UNIQUE slot). */
export async function ensureFreeSlots(sessionCookie, needed = 2) {
  const devices = await listDevices(sessionCookie);
  const tenantId = devices[0]?.tenant_id;
  if (tenantId) {
    psql(
      `DELETE FROM devices WHERE tenant_id = '${tenantId}' AND (revoked_at IS NOT NULL OR id LIKE 'e2e-device-%' OR id LIKE 'harness-%')`,
    );
  }
  const active = await listDevices(sessionCookie);
  if (active.length + needed > 3) {
    throw new Error(`need ${needed} free device slots but tenant has ${active.length}/3 active devices`);
  }
}

export async function fetchSyncToken(sessionCookie, deviceId) {
  const tokenRes = await fetchJson(
    `${APP_BASE}/api/sync/token?device_id=${encodeURIComponent(deviceId)}`,
    { headers: { Cookie: sessionCookie } },
  );
  if (tokenRes.res.status !== 200 || !tokenRes.json?.token) {
    throw new Error(`GET /sync/token failed: status ${tokenRes.res.status} body ${tokenRes.text}`);
  }
  return tokenRes.json;
}
