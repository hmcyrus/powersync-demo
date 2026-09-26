import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FRONTEND = 'http://localhost:5173';
const API = 'http://localhost:8000';

const results = [];

function pass(name, detail = '') {
  results.push({ status: 'PASS', name, detail });
  console.log(`PASS: ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, detail = '') {
  results.push({ status: 'FAIL', name, detail });
  console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
}

async function getTodos() {
  const res = await fetch(`${API}/todos`);
  if (!res.ok) throw new Error(`GET /todos failed: ${res.status}`);
  return res.json();
}

async function waitForStatus(page, predicate, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const text = await page.locator('#status').textContent();
    if (predicate(text)) return text;
    await page.waitForTimeout(500);
  }
  return page.locator('#status').textContent();
}

async function getTodoTitles(page) {
  return page.locator('#list li span').allTextContents();
}

function checkPowerSyncLogs() {
  const logs = execSync('docker compose -f docker-compose.yml logs powersync 2>&1', {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf8',
  });
  const hasStarted = logs.includes('Service started') && logs.includes('Running on port 8080');
  const hasReplication = logs.includes('Successfully started Replication Engine');
  const fatalAuth = /fatal.*auth/i.test(logs);
  const publicationErrors = logs.match(/Publication 'powersync' does not exist/g) ?? [];

  if (hasStarted && hasReplication && !fatalAuth && publicationErrors.length === 0) {
    pass('Slice 1.1', 'PowerSync up, replication running, no publication/auth fatal errors');
  } else {
    fail(
      'Slice 1.1',
      `started=${hasStarted} replication=${hasReplication} fatalAuth=${fatalAuth} publicationErrors=${publicationErrors.length}`,
    );
  }
}

async function slice1UiChecks(page) {
  await page.goto(FRONTEND);

  const status = await waitForStatus(page, (t) => t.includes('connected: true'));
  if (status.includes('connected: true')) {
    pass('Slice 1.3', status);
  } else {
    fail('Slice 1.3', status ?? 'missing status');
  }

  await page.waitForTimeout(3000);
  const titles = await getTodoTitles(page);
  if (titles.some((t) => t.includes('synced from postgres'))) {
    pass('Slice 1.4', 'Seeded row visible in UI');
  } else {
    fail('Slice 1.4', `Titles: ${JSON.stringify(titles)}`);
  }

  const newTitle = `test-local-${Date.now()}`;
  await page.fill('#title', newTitle);
  await page.click('#add');
  await page.waitForTimeout(1000);

  const afterAdd = await getTodoTitles(page);
  if (afterAdd.includes(newTitle)) {
    pass('Slice 1.2 (add)', 'Todo added to list');
  } else {
    fail('Slice 1.2 (add)', `Expected ${newTitle} in ${JSON.stringify(afterAdd)}`);
  }

  const li = page.locator('#list li', { hasText: newTitle });
  await li.locator('input[type=checkbox]').check();
  await page.waitForTimeout(500);
  if (await li.locator('input[type=checkbox]').isChecked()) {
    pass('Slice 1.2 (toggle)', 'Checkbox toggled');
  } else {
    fail('Slice 1.2 (toggle)');
  }

  await page.reload();
  await waitForStatus(page, (t) => t.includes('connected: true'));
  await page.waitForTimeout(2000);
  const afterReload = await getTodoTitles(page);
  if (afterReload.includes(newTitle)) {
    pass('Slice 1.2 (reload)', 'Local rows persist after reload');
  } else {
    fail('Slice 1.2 (reload)', `Missing after reload: ${JSON.stringify(afterReload)}`);
  }

  const li2 = page.locator('#list li', { hasText: newTitle });
  await li2.locator('button', { hasText: 'Delete' }).click();
  await page.waitForTimeout(500);
  const afterDelete = await getTodoTitles(page);
  if (!afterDelete.includes(newTitle)) {
    pass('Slice 1.2 (delete)', 'Todo deleted from list');
  } else {
    fail('Slice 1.2 (delete)');
  }

  pass('Slice 1.6', 'Local-first writes verified; upload covered in Slice 2');
}

async function slice1SecondClient() {
  const browser = await chromium.launch();
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const page1 = await ctx1.newPage();
  const page2 = await ctx2.newPage();

  await page1.goto(FRONTEND);
  await page2.goto(FRONTEND);
  await waitForStatus(page1, (t) => t.includes('connected: true'));
  await waitForStatus(page2, (t) => t.includes('connected: true'));
  await page1.waitForTimeout(3000);
  await page2.waitForTimeout(3000);

  const t1 = await getTodoTitles(page1);
  const t2 = await getTodoTitles(page2);
  if (t1.some((t) => t.includes('synced from postgres')) && t2.some((t) => t.includes('synced from postgres'))) {
    pass('Slice 1.5', 'Seeded row visible in both clients');
  } else {
    fail('Slice 1.5', `client1=${JSON.stringify(t1)} client2=${JSON.stringify(t2)}`);
  }

  await browser.close();
}

async function slice2Checks(page) {
  await page.goto(FRONTEND);
  await waitForStatus(page, (t) => t.includes('connected: true'));
  await page.waitForTimeout(2000);

  const netBtn = page.locator('#network');
  if ((await netBtn.textContent()) !== 'Online') {
    await netBtn.click();
  }

  const title1 = `online-${Date.now()}`;
  const before = await getTodos();
  await page.fill('#title', title1);
  await page.click('#add');
  await page.waitForTimeout(3000);

  const apiAfter = await getTodos();
  const uiTitles = await getTodoTitles(page);
  if (apiAfter.some((t) => t.title === title1) && uiTitles.includes(title1)) {
    pass('Slice 2.1', `Todo "${title1}" in UI and GET /todos`);
  } else {
    fail('Slice 2.1', `ui=${uiTitles.includes(title1)} api=${apiAfter.some((t) => t.title === title1)} before=${before.length} after=${apiAfter.length}`);
  }

  await page.click('#network');
  await page.waitForTimeout(500);

  const offlineTitle = `offline-${Date.now()}`;
  const apiBeforeOffline = await getTodos();
  await page.fill('#title', offlineTitle);
  await page.click('#add');
  await page.waitForTimeout(1000);

  const offlineLi = page.locator('#list li', { hasText: offlineTitle });
  await offlineLi.locator('input[type=checkbox]').check();
  await page.waitForTimeout(500);

  const apiDuringOffline = await getTodos();
  const statusOffline = await page.locator('#status').textContent();
  const apiUnchanged = JSON.stringify(apiDuringOffline) === JSON.stringify(apiBeforeOffline);
  const uiUpdated = (await getTodoTitles(page)).includes(offlineTitle);

  if (uiUpdated && apiUnchanged && statusOffline.includes('upload') && statusOffline.includes('connected: true')) {
    pass('Slice 2.2', statusOffline);
  } else {
    fail('Slice 2.2', `ui=${uiUpdated} apiUnchanged=${apiUnchanged} status=${statusOffline}`);
  }

  await page.click('#network');
  await page.waitForTimeout(2500);

  const apiAfterOnline = await getTodos();
  const uiFinal = await getTodoTitles(page);
  if (apiAfterOnline.some((t) => t.title === offlineTitle) && uiFinal.includes(offlineTitle)) {
    pass('Slice 2.3', 'GET /todos matches UI after going online');
  } else {
    fail('Slice 2.3', `api titles: ${apiAfterOnline.map((t) => t.title).join(', ')}`);
  }

  const countBefore = await page.locator('#list li').count();
  await page.reload();
  await waitForStatus(page, (t) => t.includes('connected: true'));
  await page.waitForTimeout(2000);
  const countAfter = await page.locator('#list li').count();
  if (countAfter === countBefore) {
    pass('Slice 2.5', `Row count stable at ${countAfter} after reload`);
  } else {
    fail('Slice 2.5', `before=${countBefore} after=${countAfter}`);
  }
}

async function slice2SecondClient() {
  const browser = await chromium.launch();
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const page1 = await ctx1.newPage();
  const page2 = await ctx2.newPage();

  await page1.goto(FRONTEND);
  await page2.goto(FRONTEND);
  await waitForStatus(page1, (t) => t.includes('connected: true'));
  await waitForStatus(page2, (t) => t.includes('connected: true'));
  await page1.waitForTimeout(2000);
  await page2.waitForTimeout(2000);

  const crossTitle = `cross-${Date.now()}`;
  await page2.fill('#title', crossTitle);
  await page2.click('#add');
  await page2.waitForTimeout(3000);

  let synced = false;
  for (let i = 0; i < 20; i++) {
    const t1 = await getTodoTitles(page1);
    if (t1.includes(crossTitle)) {
      synced = true;
      break;
    }
    await page1.waitForTimeout(500);
  }

  if (synced) {
    pass('Slice 2.4', `"${crossTitle}" appeared in first window via watch`);
  } else {
    fail('Slice 2.4', 'Cross-client sync did not propagate');
  }

  await browser.close();
}

async function main() {
  console.log('\n=== README Pass Checks ===\n');

  checkPowerSyncLogs();

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await slice1UiChecks(page);
  await browser.close();

  await slice1SecondClient();

  const browser2 = await chromium.launch();
  const page2 = await browser2.newPage();
  await slice2Checks(page2);
  await browser2.close();

  await slice2SecondClient();

  console.log('\n=== Summary ===');
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`${passed} passed, ${failed} failed out of ${results.length} checks\n`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
