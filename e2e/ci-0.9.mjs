/**
 * Test 0.9 — validate CI workflow for the focused Phase 0 suite (local only; no GitHub dispatch).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'poc-suite.yml');

const REQUIRED_SCRIPTS = ['test:0.5', 'test:0.6', 'test:0.7', 'test:0.8'];
const FORBIDDEN = ['pass-checks.mjs', 'stream-form-spike.mjs', 'npm test\n', 'npm test\r'];

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function pass(message) {
  console.log(`PASS: ${message}`);
}

function loadYaml(text) {
  const require = createRequire(import.meta.url);
  const yamlPaths = [
    path.join(ROOT, 'e2e', 'node_modules', 'yaml', 'dist', 'index.js'),
    path.join(ROOT, 'frontend', 'node_modules', 'yaml', 'dist', 'index.js'),
  ];
  for (const yamlPath of yamlPaths) {
    if (!fs.existsSync(yamlPath)) continue;
    const { parse } = require(yamlPath);
    return parse(text);
  }
  fail('yaml parser not found (run npm ci in e2e or frontend)');
}

if (!fs.existsSync(WORKFLOW_PATH)) {
  fail(`workflow missing: ${WORKFLOW_PATH}`);
}
pass(`workflow file exists: .github/workflows/poc-suite.yml`);

const text = fs.readFileSync(WORKFLOW_PATH, 'utf8');
if (text.includes('\t')) {
  fail('workflow YAML contains tab characters');
}

let doc;
try {
  doc = loadYaml(text);
} catch (err) {
  fail(`workflow YAML parse error: ${err.message}`);
}
pass('workflow file is valid YAML');

const on = doc?.on;
const hasPush = on === 'push' || (on && typeof on === 'object' && 'push' in on);
const hasPullRequest =
  on === 'pull_request' || (on && typeof on === 'object' && 'pull_request' in on);
if (!hasPush || !hasPullRequest) {
  fail('workflow must trigger on push and pull_request');
}
pass('workflow triggers on push and pull_request');

if (!/docker compose up/i.test(text)) {
  fail('workflow must start the Docker stack (docker compose up)');
}
pass('workflow starts Docker stack via docker compose up');

if (!/npm run build/.test(text)) {
  fail('workflow must build frontend (required for Caddy dist and 0.5–0.8)');
}
pass('workflow builds frontend before running suite');

for (const forbidden of FORBIDDEN) {
  if (text.includes(forbidden)) {
    fail(`workflow must not reference forbidden target: ${forbidden.trim()}`);
  }
}
if (/\bnpm test\b/.test(text)) {
  fail('workflow must not run bare npm test (pass-checks.mjs)');
}
pass('workflow excludes pass-checks.mjs and stream-form-spike.mjs');

for (const script of REQUIRED_SCRIPTS) {
  if (!text.includes(script)) {
    fail(`workflow must invoke npm run ${script}`);
  }
}
pass(`workflow invokes ${REQUIRED_SCRIPTS.join(', ')}`);

console.log('ci-0.9: all checks passed');
process.exit(0);
