import { db } from './db.js';
import { Connector } from './connector.js';

const listEl = document.getElementById('list');
const statusEl = document.getElementById('status');
const titleInput = document.getElementById('title');
const addBtn = document.getElementById('add');

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
      await db.execute('UPDATE todos SET is_completed = ? WHERE id = ?', [
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
      await db.execute('DELETE FROM todos WHERE id = ?', [row.id]);
    });

    li.append(checkbox, title, deleteBtn);
    listEl.appendChild(li);
  }
}

db.watch(
  'SELECT id, title, is_completed, created_at FROM todos ORDER BY created_at',
  [],
  {
    onResult: (result) => {
      renderTodos(rowsFromResult(result));
    },
  },
);

db.registerListener({
  statusChanged: (status) => {
    statusEl.textContent = `connected: ${status.connected}`;
  },
});

addBtn.addEventListener('click', async () => {
  const title = titleInput.value.trim();
  if (!title) return;
  await db.execute(
    'INSERT INTO todos (id, title, is_completed, created_at) VALUES (?, ?, ?, ?)',
    [crypto.randomUUID(), title, 0, new Date().toISOString()],
  );
  titleInput.value = '';
});

titleInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addBtn.click();
});

await db.init();
await db.connect(new Connector());
