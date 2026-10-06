import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchJson, fetchSyncToken, SYNC_ENDPOINT } from './api-client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const DEV_HS256_SECRET_B64URL = 'sNIjdpcb8wPdBbT7m7sc2QVBmVogwxLTcZCzxxbB7qU';
const SYNC_AUDIENCE = 'http://sync.localhost';
const JWT_KID = 'poc-key-1';

function b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  return buf.toString('base64url');
}

function b64urlJson(obj) {
  return b64url(JSON.stringify(obj));
}

let cachedPrivateKeyPem = null;

export function fetchApiPrivateKeyPem() {
  if (cachedPrivateKeyPem) return cachedPrivateKeyPem;
  cachedPrivateKeyPem = execSync('docker compose exec -T api cat /data/jwt.pem', {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return cachedPrivateKeyPem;
}

function signRs256(payload, privateKeyPem, kid = JWT_KID) {
  const header = { alg: 'RS256', typ: 'JWT', kid };
  const encodedHeader = b64urlJson(header);
  const encodedPayload = b64urlJson(payload);
  const data = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.createSign('RSA-SHA256').update(data).sign(privateKeyPem);
  return `${data}.${b64url(signature)}`;
}

function signHs256(payload, secretB64url, kid = 'dev-key-1') {
  const header = { alg: 'HS256', typ: 'JWT', kid };
  const encodedHeader = b64urlJson(header);
  const encodedPayload = b64urlJson(payload);
  const data = `${encodedHeader}.${encodedPayload}`;
  const key = Buffer.from(secretB64url, 'base64url');
  const signature = crypto.createHmac('sha256', key).update(data).digest();
  return `${data}.${b64url(signature)}`;
}

/** Tamper with JWT payload claims while keeping the original (now invalid) signature. */
export function forgedClaimsToken(validToken, claimOverrides) {
  const parts = validToken.split('.');
  if (parts.length !== 3) {
    throw new Error('expected a three-part JWT');
  }
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  Object.assign(payload, claimOverrides);
  const tamperedPayload = b64urlJson(payload);
  return `${parts[0]}.${tamperedPayload}.${parts[2]}`;
}

/** HS256 token for another tenant using the retired dev shared secret (wrong key for RS256 JWKS). */
export function wrongKeyOtherTenantToken(otherTenantId, deviceId) {
  const now = Math.floor(Date.now() / 1000);
  return signHs256(
    {
      sub: otherTenantId,
      device_id: deviceId,
      aud: SYNC_AUDIENCE,
      iat: now,
      exp: now + 3600,
    },
    DEV_HS256_SECRET_B64URL,
  );
}

/** RS256 token that expired one hour ago (valid shape, wrong lifetime). */
export function expiredToken(tenantId, deviceId, privateKeyPem = fetchApiPrivateKeyPem()) {
  const now = Math.floor(Date.now() / 1000);
  return signRs256(
    {
      sub: tenantId,
      device_id: deviceId,
      aud: SYNC_AUDIENCE,
      iat: now - 7200,
      exp: now - 3600,
    },
    privateKeyPem,
  );
}

export async function legitimateTokenForIdentity(identity) {
  const tokenRes = await fetchSyncToken(identity.sessionCookie, identity.deviceId);
  return tokenRes.token;
}

export { SYNC_ENDPOINT };
