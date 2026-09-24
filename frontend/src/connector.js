import { mintDevToken } from './devToken.js';

export class Connector {
  async fetchCredentials() {
    return {
      endpoint: 'http://localhost:8080',
      token: await mintDevToken(),
    };
  }
}
