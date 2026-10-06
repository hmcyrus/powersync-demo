const IDENTITY_KEY = 'poc_identity';
const LEGACY_DEVICE_KEY = 'poc_device_id';

export function getIdentity() {
  const raw = localStorage.getItem(IDENTITY_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.tenantId && parsed?.deviceId) return parsed;
  } catch {
    /* ignore */
  }
  return null;
}

export function saveIdentity(identity) {
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
}

export function getDeviceId() {
  const identity = getIdentity();
  if (identity?.deviceId) return identity.deviceId;
  let id = localStorage.getItem(LEGACY_DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(LEGACY_DEVICE_KEY, id);
  }
  return id;
}

export function getTenantId() {
  return getIdentity()?.tenantId ?? null;
}
