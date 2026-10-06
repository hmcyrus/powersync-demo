import { SYNC_ENDPOINT } from './attack-tokens.mjs';

/** Connector that presents an attack token for sync (upload disabled). */
export class AttackConnector {
  constructor(token, endpoint = SYNC_ENDPOINT) {
    this.token = token;
    this.endpoint = endpoint;
  }

  async fetchCredentials() {
    return {
      endpoint: this.endpoint,
      token: this.token,
    };
  }

  async uploadData() {
    // Attack scenarios only test download isolation.
  }
}
