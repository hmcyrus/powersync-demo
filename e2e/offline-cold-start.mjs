/**
 * Test 0.5 — offline cold start spike (Q5).
 * Playwright persistent context: sync once online, go offline, close and reopen, app boots from cache with local data.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const FRONTEND = 'http://localhost:5173';

async function waitForStatus(page, predicate, timeout = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const text = await page.locator('#status').textContent();
    if (predicate(text)) return text;
    await page.waitForTimeout(500);
  }
  return page.locator('#status').textContent();
}

async function waitForServiceWorker(page, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ready = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      const reg = await navigator.serviceWorker.getRegistration();
      return Boolean(reg?.active?.state === 'activated' || reg?.installing || reg?.waiting);
    });
    if (ready) {
      await page.evaluate(() => navigator.serviceWorker.ready);
      return;
    }
    await page.waitForTimeout(500);
  }
  throw new Error('Service worker did not activate in time');
}

async function getTodoTitles(page) {
  return page.locator('#list li span').allTextContents();
}

async function runColdStartCheck(userDataDir) {
  const localTitle = `cold-start-${Date.now()}`;

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    serviceWorkers: 'allow',
  });

  try {
    const page = await context.newPage();
    await page.goto(FRONTEND, { waitUntil: 'domcontentloaded' });

    const onlineStatus = await waitForStatus(page, (t) => t.includes('connected: true'));
    if (!onlineStatus.includes('connected: true')) {
      throw new Error(`Expected online sync; status=${onlineStatus}`);
    }

    await page.waitForTimeout(3000);
    const seeded = await getTodoTitles(page);
    if (!seeded.some((t) => t.includes('synced from postgres'))) {
      throw new Error(`Seeded row missing before offline: ${JSON.stringify(seeded)}`);
    }
    await page.fill('#title', localTitle);
    await page.click('#add');
    await page.waitForTimeout(1500);

    const withLocal = await getTodoTitles(page);
    if (!withLocal.includes(localTitle)) {
      throw new Error(`Local todo not visible before offline: ${JSON.stringify(withLocal)}`);
    }

    await waitForServiceWorker(page);
    await context.setOffline(true);
  } finally {
    await context.close();
  }

  const offlineContext = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    serviceWorkers: 'allow',
  });

  try {
    await offlineContext.setOffline(true);
    const page = offlineContext.pages()[0] ?? (await offlineContext.newPage());
    await page.goto(FRONTEND, { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(
      () => document.querySelector('#list li span')?.textContent?.length > 0,
      null,
      { timeout: 30000 },
    );

    const titles = await getTodoTitles(page);
    const status = await page.locator('#status').textContent();

    const hasSeeded = titles.some((t) => t.includes('synced from postgres'));
    const hasLocal = titles.includes(localTitle);
    if (!hasSeeded || !hasLocal) {
      throw new Error(
        `Offline cold start missing data: seeded=${hasSeeded} local=${hasLocal} titles=${JSON.stringify(titles)} status=${status}`,
      );
    }

    console.log(`PASS: 0.5 offline cold start — ${titles.length} todos visible offline; status=${status}`);
    return { titles, status };
  } finally {
    await offlineContext.close();
  }
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poc-05-'));
  console.log(`User data dir: ${userDataDir}`);
  console.log(`Frontend: ${FRONTEND}\n`);

  try {
    await runColdStartCheck(userDataDir);
    process.exit(0);
  } catch (err) {
    console.error(`FAIL: 0.5 offline cold start — ${err.message}`);
    process.exit(1);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
