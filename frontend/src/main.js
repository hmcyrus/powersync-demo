import { registerSW } from 'virtual:pwa-register';
import { AuthRequiredError, hasSession, signInUrl } from './auth.js';
import { initDb, getDb } from './db.js';
import { Connector, setOnline, getOnline } from './connector.js';
import { getIdentity, getDeviceId, getTenantId } from './identity.js';

registerSW({ immediate: true });

const listEl = document.getElementById('list');
const catalogEl = document.getElementById('catalog');
const statusEl = document.getElementById('status');
const authPanelEl = document.getElementById('auth-panel');
const appPanelEl = document.getElementById('app-panel');
const signInEl = document.getElementById('sign-in');
const titleInput = document.getElementById('title');
const addBtn = document.getElementById('add');
const networkBtn = document.getElementById('network');

let syncStarted = false;
let watchesBound = false;

function showSignIn(message = 'Sign in required') {
  authPanelEl.hidden = false;
  appPanelEl.hidden = true;
  statusEl.textContent = message;
}

function showApp() {
  authPanelEl.hidden = true;
  appPanelEl.hidden = false;
}

function showConnectionNeeded() {
  showSignIn('Connection needed to sign in');
}

signInEl.href = signInUrl();

function rowsFromResult(result) {
  if (result.rows._array) return result.rows._array;
  return Array.from(result.rows);
}

function renderTodos(rows) {
  listEl.replaceChildren();
  for (const row of rows) {
    const li = document.createElement('li');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = row.is_completed === 1;
    checkbox.addEventListener('change', async () => {
      await getDb().execute('UPDATE todos SET is_completed = ? WHERE id = ?', [
        checkbox.checked ? 1 : 0,
        row.id,
      ]);
    });

    const title = document.createElement('span');
    title.textContent = row.title;

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', async () => {
      await getDb().execute('DELETE FROM todos WHERE id = ?', [row.id]);
    });

    li.append(checkbox, title, deleteBtn);
    listEl.appendChild(li);
  }
}

function renderCatalog(rows) {
  catalogEl.replaceChildren();
  for (const row of rows) {
    const li = document.createElement('li');
    li.textContent = row.name;
    li.dataset.kind = row.kind;
    li.dataset.tenant = row.tenant_id ?? 'shared';
    catalogEl.appendChild(li);
  }
}

function updateNetworkLabel() {
  networkBtn.textContent = getOnline() ? 'Online' : 'Offline';
}

function bindDbWatches(db) {
  if (watchesBound) return;
  watchesBound = true;

  db.watch(
    'SELECT id, title, is_completed, created_at FROM todos ORDER BY created_at',
    [],
    {
      onResult: (result) => {
        renderTodos(rowsFromResult(result));
      },
    },
  );

  db.watch(
    'SELECT id, tenant_id, name, kind FROM catalog ORDER BY name',
    [],
    {
      onResult: (result) => {
        renderCatalog(rowsFromResult(result));
      },
    },
  );

  db.registerListener({
    statusChanged: (status) => {
      if (statusEl.textContent === 'Sign in to sync') {
        return;
      }
      const uploadError = status.uploadError;
      statusEl.textContent = uploadError
        ? `connected: ${status.connected}; upload: ${uploadError.message}`
        : `connected: ${status.connected}`;
    },
  });
}

addBtn.addEventListener('click', async () => {
  const title = titleInput.value.trim();
  if (!title) return;
  const tenantId = getTenantId();
  if (!tenantId) return;
  await getDb().execute(
    'INSERT INTO todos (id, tenant_id, title, is_completed, created_at) VALUES (?, ?, ?, ?, ?)',
    [crypto.randomUUID(), tenantId, title, 0, new Date().toISOString()],
  );
  titleInput.value = '';
});

titleInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addBtn.click();
});

networkBtn.addEventListener('click', () => {
  setOnline(!getOnline());
  updateNetworkLabel();
});

updateNetworkLabel();

function connectInBackground(db) {
  if (syncStarted) return;
  syncStarted = true;

  const connector = new Connector({
    onAuthRequired: () => {
      statusEl.textContent = 'Sign in to sync';
      syncStarted = false;
      queueMicrotask(() => {
        db.disconnect().catch(() => {});
      });
    },
  });

  statusEl.textContent = 'Connecting…';
  db.connect(connector, { retryDelayMs: 1000 }).catch((err) => {
    if (err instanceof AuthRequiredError) {
      if (getIdentity()) {
        statusEl.textContent = 'Sign in to sync';
      } else {
        showSignIn();
      }
      syncStarted = false;
      return;
    }
    if (getIdentity()) {
      statusEl.textContent = `connected: false`;
    }
    syncStarted = false;
  });
}

async function bootWithIdentity(identity) {
  const db = initDb(identity.tenantId);
  bindDbWatches(db);
  await db.init();
  showApp();
  connectInBackground(db);
}

async function bootWithoutIdentity() {
  showSignIn();

  let sessionOk = false;
  try {
    sessionOk = await hasSession();
  } catch {
    showConnectionNeeded();
    return;
  }

  if (!sessionOk) {
    return;
  }

  statusEl.textContent = 'Preparing…';
  try {
    const connector = new Connector();
    await connector.registerIfNeeded();
    const identity = getIdentity();
    if (!identity) {
      showSignIn();
      return;
    }
    await bootWithIdentity(identity);
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      showSignIn();
      return;
    }
    if (!navigator.onLine) {
      showConnectionNeeded();
      return;
    }
    statusEl.textContent = err.message || 'Sign in required';
  }
}

const existingIdentity = getIdentity();
if (existingIdentity) {
  await bootWithIdentity(existingIdentity);
} else {
  await bootWithoutIdentity();
}
