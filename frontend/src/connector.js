import { AuthRequiredError } from './auth.js';
import { getDeviceId, getIdentity, saveIdentity } from './identity.js';

let isOnline = true;

export function setOnline(value) {
  isOnline = value;
}

export function getOnline() {
  return isOnline;
}

export class Connector {
  constructor({ onAuthRequired } = {}) {
    this.onAuthRequired = onAuthRequired;
    this.authSuspended = false;
  }

  async registerIfNeeded() {
    const deviceId = getDeviceId();
    const response = await fetch('/api/devices/register', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: deviceId, name: 'browser' }),
    });
    if (response.status === 401) {
      throw new AuthRequiredError();
    }
    if (response.status === 409) {
      throw new Error('device limit reached (max 3 devices)');
    }
    if (!response.ok) {
      throw new Error(`POST /devices/register failed: ${response.status}`);
    }
    const data = await response.json();
    const identity = {
      tenantId: data.tenant_id,
      deviceId: data.id,
      slot: data.slot,
      email: data.email,
    };
    saveIdentity(identity);
    return identity;
  }

  async fetchCredentials() {
    if (this.authSuspended) {
      throw new AuthRequiredError();
    }

    const deviceId = getDeviceId();
    try {
      await this.registerIfNeeded();
    } catch (err) {
      if (err instanceof AuthRequiredError && getIdentity()) {
        this.authSuspended = true;
        this.onAuthRequired?.();
        throw err;
      }
      throw err;
    }

    const response = await fetch(
      `/api/sync/token?device_id=${encodeURIComponent(deviceId)}`,
      { credentials: 'include' },
    );
    if (response.status === 401) {
      if (getIdentity()) {
        this.authSuspended = true;
        this.onAuthRequired?.();
      }
      throw new AuthRequiredError();
    }
    if (!response.ok) {
      throw new Error(`GET /sync/token failed: ${response.status}`);
    }
    const data = await response.json();
    return {
      endpoint: 'http://sync.localhost',
      token: data.token,
    };
  }

  async uploadData(database) {
    if (!isOnline) {
      throw new Error('offline');
    }

    const transaction = await database.getNextCrudTransaction();
    if (!transaction) {
      return;
    }

    for (const op of transaction.crud) {
      if (op.op === 'PUT') {
        const response = await fetch('/api/todos', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: op.id, ...op.opData }),
        });
        if (response.status === 401) {
          throw new AuthRequiredError();
        }
        if (!response.ok) {
          throw new Error(`POST /api/todos failed: ${response.status}`);
        }
      } else if (op.op === 'PATCH') {
        const response = await fetch(`/api/todos/${op.id}`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(op.opData),
        });
        if (response.status === 401) {
          throw new AuthRequiredError();
        }
        if (!response.ok) {
          throw new Error(`PATCH /api/todos/${op.id} failed: ${response.status}`);
        }
      } else if (op.op === 'DELETE') {
        const response = await fetch(`/api/todos/${op.id}`, {
          method: 'DELETE',
          credentials: 'include',
        });
        if (response.status === 401) {
          throw new AuthRequiredError();
        }
        if (!response.ok) {
          throw new Error(`DELETE /api/todos/${op.id} failed: ${response.status}`);
        }
      } else {
        throw new Error(`Unknown op: ${op.op}`);
      }
    }

    await transaction.complete();
  }
}
