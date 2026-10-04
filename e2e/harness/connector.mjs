import { APP_BASE, fetchJson, fetchSyncToken, SYNC_ENDPOINT } from './api-client.mjs';

export class HarnessConnector {
  constructor(identity) {
    this.identity = identity;
  }

  async fetchCredentials() {
    const tokenRes = await fetchSyncToken(this.identity.sessionCookie, this.identity.deviceId);
    return {
      endpoint: SYNC_ENDPOINT,
      token: tokenRes.token,
    };
  }

  async uploadData(database) {
    const transaction = await database.getNextCrudTransaction();
    if (!transaction) {
      return;
    }

    const batch = transaction.crud.map((op) => ({
      op: op.op,
      table: op.table,
      id: op.id,
      opData: op.opData,
    }));

    const upload = await fetchJson(`${APP_BASE}/api/sync/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${(await this.fetchCredentials()).token}`,
      },
      body: JSON.stringify({ batch }),
    });

    if (upload.res.status !== 200 || upload.json?.ok !== true) {
      throw new Error(`POST /sync/upload failed: status ${upload.res.status} body ${upload.text}`);
    }

    await transaction.complete();
  }
}
