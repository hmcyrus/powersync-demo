/**
 * Standing rule — current-app contract check.
 * Loads http://app.localhost/ and asserts sign-in, connected: true, and stored tenant_id on POST /api/todos after Add.
 */
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = 'http://app.localhost';

function psql(sql) {
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  execSync(`docker compose exec -T postgres psql -U postgres -d postgres -c "${oneLine}"`, {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

function prepareTestAccount() {
  psql("INSERT INTO allowed_emails (email) VALUES ('doctor@example.com') ON CONFLICT (email) DO NOTHING;");
  psql(
    "DELETE FROM devices WHERE tenant_id = (SELECT tenant_id FROM users WHERE email = 'doctor@example.com');",
  );
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function pass(message) {
  console.log(`PASS: ${message}`);
}

async function waitForStatus(page, predicate, timeout = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const text = await page.locator('#status').textContent();
    if (predicate(text)) return text;
    await page.waitForTimeout(500);
  }
  return page.locator('#status').textContent();
}

async function main() {
  prepareTestAccount();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(90000);

  await page.goto(APP, { waitUntil: 'domcontentloaded' });

  const authPanel = page.locator('#auth-panel');
  if (!(await authPanel.isVisible())) {
    fail('sign-in: auth panel not visible on first load');
  }
  pass('sign-in: auth panel visible before sign-in');

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.click('#sign-in'),
  ]);
  await page.waitForFunction(
    () => {
      const panel = document.getElementById('app-panel');
      return panel && !panel.hidden;
    },
    { timeout: 90000 },
  );
  pass('sign-in: app panel visible after OIDC');

  const status = await waitForStatus(page, (t) => t.includes('connected: true'));
  if (!status.includes('connected: true')) {
    fail(`connected: expected connected: true, got ${status}`);
  }
  pass(`connected: ${status.trim()}`);

  const identity = await page.evaluate(() => {
    const raw = localStorage.getItem('poc_identity');
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  });
  if (!identity?.tenantId) {
    fail('tenant_id: poc_identity.tenantId missing in localStorage');
  }
  if (identity.tenantId === 'dev') {
    fail('tenant_id: stored tenant is hardcoded dev, not session tenant');
  }

  const addTitle = `current-app-${Date.now()}`;
  const uploadRequest = page.waitForRequest(
    (req) => req.method() === 'POST' && /\/api\/todos\/?$/.test(new URL(req.url()).pathname),
    { timeout: 60000 },
  );

  await page.fill('#title', addTitle);
  await page.click('#add');

  let postBody;
  try {
    const req = await uploadRequest;
    postBody = req.postDataJSON();
  } catch {
    fail('tenant_id: no POST /api/todos observed after Add');
  }

  if (postBody.tenant_id !== identity.tenantId) {
    fail(
      `tenant_id: POST /api/todos sent ${postBody.tenant_id ?? '(missing)'}; identity has ${identity.tenantId}`,
    );
  }
  pass(`tenant_id: POST /api/todos tenant_id=${postBody.tenant_id} matches poc_identity`);

  await browser.close();
  console.log('current-app: all checks passed');
  process.exit(0);
}

main().catch((err) => {
  fail(err.message ?? String(err));
});
