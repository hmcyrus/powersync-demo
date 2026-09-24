import { mintDevToken } from './devToken.js';

let isOnline = true;

export function setOnline(value) {
  isOnline = value;
}

export function getOnline() {
  return isOnline;
}

export class Connector {
  async fetchCredentials() {
    return {
      endpoint: 'http://localhost:8080',
      token: await mintDevToken(),
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
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: op.id, ...op.opData }),
        });
        if (!response.ok) {
          throw new Error(`POST /api/todos failed: ${response.status}`);
        }
      } else if (op.op === 'PATCH') {
        const response = await fetch(`/api/todos/${op.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(op.opData),
        });
        if (!response.ok) {
          throw new Error(`PATCH /api/todos/${op.id} failed: ${response.status}`);
        }
      } else if (op.op === 'DELETE') {
        const response = await fetch(`/api/todos/${op.id}`, {
          method: 'DELETE',
        });
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
