const SECRET_B64URL = 'sNIjdpcb8wPdBbT7m7sc2QVBmVogwxLTcZCzxxbB7qU';

function b64urlToBytes(value) {
  const pad = '='.repeat((4 - (value.length % 4)) % 4);
  const b64 = (value + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function jsonB64url(obj) {
  return bytesToB64url(new TextEncoder().encode(JSON.stringify(obj)));
}

export async function mintDevToken() {
  const key = await crypto.subtle.importKey(
    'raw',
    b64urlToBytes(SECRET_B64URL),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT', kid: 'dev-key-1' };
  const payload = {
    sub: 'dev',
    aud: 'http://localhost:8080',
    iat: now,
    exp: now + 3600,
  };
  const data = `${jsonB64url(header)}.${jsonB64url(payload)}`;
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${data}.${bytesToB64url(new Uint8Array(sig))}`;
}
