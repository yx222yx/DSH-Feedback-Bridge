import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const hasDsh = (() => {
  try {
    execFileSync('dsh', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();
const hasPnpm = (() => {
  try {
    execFileSync('pnpm', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();
const hasPlaywrightCore = (() => {
  try {
    createRequire(import.meta.url).resolve('playwright-core');
    return true;
  } catch {
    return false;
  }
})();

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', ...options });
}

/**
 * Pack a directory and return the produced tarball filename. Some pnpm
 * versions print a dependency-verification preamble to stdout before the
 * JSON payload, so the JSON array is located by its opening bracket instead
 * of assuming the output starts with it.
 */
function packFilename(cwd) {
  const output = run('npm', ['pack', '--json'], { cwd });
  const start = output.indexOf('[');
  if (start === -1) throw new Error('npm pack produced no JSON array: ' + output.slice(0, 200));
  return JSON.parse(output.slice(start))[0].filename;
}

/** Dismiss the sequential first-run modals ("Internal Testing Notice" then
 * "Add an API key to get started") that cover the sidebar on a clean profile.
 * No-op once every modal is gone. */
async function dismissFirstRunModals(page) {
  await page.waitForSelector('[role="dialog"]', { timeout: 60_000 }).catch(() => {});
  for (let step = 0; step < 6; step += 1) {
    const dialog = page.locator('[role="dialog"]:visible').first();
    if (!(await dialog.count())) break;
    const dialogText = await dialog.innerText();
    if (dialogText.includes('Internal Testing Notice')) {
      await dialog.getByRole('button', { name: 'Continue' }).click();
    } else if (dialogText.includes('Add an API key')) {
      await dialog.getByRole('button', { name: 'Configure later' }).click();
    } else {
      break;
    }
    await dialog.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(500);
  }
}

/** Wait until the workspace shows the persisted-draft restored notice. */
async function waitForRestored(page) {
  await page.waitForSelector('[data-testid="dsh-feedback-notice"]', { timeout: 10_000 });
  const text = (await page.textContent('[data-testid="dsh-feedback-notice"]')).trim();
  assert.equal(text, 'Restored your in-progress draft');
}

/** Poll a path until it satisfies a predicate or the timeout expires. */
async function waitForFile(path, predicate, { timeoutMs = 15_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(path)) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for ${path}`);
}

test('packed bundle installs into a clean DSH Web profile and serves the status route', { skip: !hasDsh || !hasPnpm }, async () => {
  const tarball = packFilename(repoRoot);
  const tarballPath = join(repoRoot, tarball);
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-feedback-bridge-acceptance-'));
  const profileDir = join(dshHome, 'profiles', 'web');

  try {
    // Install the packed artifact exactly the way a user installs a bundle.
    run('dsh', ['plugin', '--profile', 'web', 'add', tarballPath], {
      cwd: repoRoot,
      env: { ...process.env, DSH_HOME: dshHome },
    });

    const profileManifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
    assert.ok(profileManifest.dsh.profile.bundles.includes('dsh-feedback-bridge'));

    const composed = run('dsh', ['--profile', 'web', '--dump-config'], {
      cwd: repoRoot,
      env: { ...process.env, DSH_HOME: dshHome },
    });
    assert.match(composed, /- id: dsh-feedback-bridge\s*\n\s*name: dsh-feedback-bridge/);

    const cleanEnv = { ...process.env, DSH_HOME: dshHome };
    delete cleanEnv.DSH_VERSION;

    // Boot the Web profile with no DeepSeek API key and no GitHub account.
    const child = spawn('dsh', ['--profile', 'web', '--no-open', '--port', '0'], {
      cwd: repoRoot,
      env: cleanEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const port = await new Promise((resolvePort, reject) => {
      let stdout = '';
      const timeout = setTimeout(() => reject(new Error(`dsh web did not print a URL; stderr: ${stderr}`)), 30_000);
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
        if (match !== null) {
          clearTimeout(timeout);
          resolvePort(Number(match[1]));
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`dsh web exited before printing a URL (code ${code}); stderr: ${stderr}`));
      });
    });

    try {
      const status = await fetch(`http://127.0.0.1:${port}/dsh-feedback-bridge/status`).then((response) => response.json());
      assert.equal(status.name, 'DSH Feedback Bridge');
      assert.equal(status.status, 'loaded');
      assert.equal(status.dshVersion, '0.1.1-rc.2');
      assert.equal(status.compatible, true);

      const clientBundle = await fetch(`http://127.0.0.1:${port}/plugins/dsh-feedback-bridge/client.js`).then((response) => response.text());
      assert.match(clientBundle, /__ModuleLoader__\.load\(\{\s*id:\s*"dsh-feedback-bridge"/);
      assert.match(clientBundle, /DSH Feedback Bridge/);

      // Issue #3: the served bundle carries the left-nav entry, the workspace,
      // the markdown builder, and the official manual-submission destination —
      // with no GitHub API call sites anywhere in it.
      assert.match(clientBundle, /sidebar\.footer\.action/);
      assert.match(clientBundle, /社区反馈/);
      assert.match(clientBundle, /buildDraftMarkdown/);
      assert.match(clientBundle, /https:\/\/github\.com\/deepseek-ai\/deepseek-harness\/discussions/);
      assert.doesNotMatch(clientBundle, /api\.github\.com/);
      assert.doesNotMatch(clientBundle, /fetch\s*\([^)]*github|sendBeacon\s*\([^)]*github/);

      // The Web GUI boot manifest must include the client bundle so the
      // browser actually loads the status section.
      const indexHtml = await fetch(`http://127.0.0.1:${port}/`).then((response) => response.text());
      assert.match(indexHtml, /dsh-feedback-bridge\/client\.js\?rev=[0-9a-f]+/);
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise((resolveExit) => child.once('exit', resolveExit));
      }
    }

    // The same installed bundle must refuse to boot on an incompatible DSH
    // version before the web server opens.
    const incompatible = spawn('dsh', ['--profile', 'web', '--no-open', '--port', '0'], {
      cwd: repoRoot,
      env: { ...cleanEnv, DSH_VERSION: '0.0.9' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let incompatibleStderr = '';
    incompatible.stderr.on('data', (chunk) => {
      incompatibleStderr += chunk.toString();
    });
    const incompatibleExit = await new Promise((resolveExit) => incompatible.once('exit', resolveExit));
    assert.notEqual(incompatibleExit, 0);
    assert.match(incompatibleStderr, /dsh-feedback-bridge: incompatible DeepSeek Harness version 0\.0\.9/);
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
    rmSync(tarballPath, { force: true });
  }
});

test('browser click-through: left-nav 社区反馈 entry opens the workspace, exports exact Markdown, restores and cancels with zero external requests', { skip: !hasDsh || !hasPnpm || !hasPlaywrightCore }, async () => {
  const { chromium } = await import('playwright-core');
  const tarball = packFilename(repoRoot);
  const tarballPath = join(repoRoot, tarball);
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-feedback-bridge-browser-'));
  const profileDir = join(dshHome, 'profiles', 'web');

  try {
    // Install the packed artifact exactly the way a user installs a bundle.
    run('dsh', ['plugin', '--profile', 'web', 'add', tarballPath], {
      cwd: repoRoot,
      env: { ...process.env, DSH_HOME: dshHome },
    });

    const cleanEnv = { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_MODE: 'DISABLED' };
    delete cleanEnv.DSH_VERSION;

    const child = spawn('dsh', ['--profile', 'web', '--no-open', '--port', '0'], {
      cwd: repoRoot,
      env: cleanEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const port = await new Promise((resolvePort, reject) => {
      let stdout = '';
      const timeout = setTimeout(() => reject(new Error(`dsh web did not print a URL; stderr: ${stderr}`)), 30_000);
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
        if (match !== null) {
          clearTimeout(timeout);
          resolvePort(Number(match[1]));
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`dsh web exited before printing a URL (code ${code}); stderr: ${stderr}`));
      });
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const requests = [];
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ acceptDownloads: true });
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl });
      const page = await context.newPage();
      page.on('request', (request) => requests.push(request.url()));
      page.on('websocket', (socket) => requests.push(socket.url()));

      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunModals(page);

      // The left-navigation entry hydrates with the client app.
      await page.waitForSelector('[data-testid="dsh-feedback-trigger"]', { timeout: 60_000 });
      const triggerText = (await page.textContent('[data-testid="dsh-feedback-trigger"]')).trim();
      assert.equal(triggerText, '社区反馈');

      // Selecting the entry opens the feedback workspace directly.
      await page.click('[data-testid="dsh-feedback-trigger"]');
      await page.waitForSelector('[data-testid="dsh-feedback-workspace"]', { timeout: 30_000 });
      const typeValue = await page.inputValue('[data-testid="dsh-feedback-type-select"]');
      assert.equal(typeValue, 'custom');

      // Fill the five editable fields.
      await page.fill('[data-testid="dsh-feedback-title"]', 'Add a plugin API to Harness');
      await page.fill('[data-testid="dsh-feedback-scenario"]', 'I often want to call custom tools in conversations.');
      await page.fill('[data-testid="dsh-feedback-gap"]', 'Harness exposes no public plugin registration interface.');
      await page.fill('[data-testid="dsh-feedback-desired"]', 'Provide a documented plugin registration API.');
      await page.fill('[data-testid="dsh-feedback-context"]', 'User stories and sample code.');

      const expectedMarkdown = [
        '# Add a plugin API to Harness',
        '',
        '## Scenario',
        '',
        'I often want to call custom tools in conversations.',
        '',
        '## The problem or situation you encountered',
        '',
        'Harness exposes no public plugin registration interface.',
        '',
        '## Desired result',
        '',
        'Provide a documented plugin registration API.',
        '',
        '## Additional context',
        '',
        'User stories and sample code.',
      ].join('\n');

      // The review card shows the exact Markdown that will be exported.
      const preview = (await page.textContent('[data-testid="dsh-feedback-preview"]')).trim();
      assert.equal(preview, expectedMarkdown);

      // Copy writes the exact Markdown to the real clipboard.
      await page.click('[data-testid="dsh-feedback-copy"]');
      await page.waitForSelector('[data-testid="dsh-feedback-notice"]', { timeout: 10_000 });
      const notice = (await page.textContent('[data-testid="dsh-feedback-notice"]')).trim();
      assert.equal(notice, 'Copied to clipboard');
      const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
      assert.equal(clipboardText, expectedMarkdown);

      // Export downloads a file carrying the exact Markdown.
      const downloadPromise = page.waitForEvent('download');
      await page.click('[data-testid="dsh-feedback-export"]');
      const download = await downloadPromise;
      const downloadPath = await download.path();
      assert.ok(downloadPath, 'download must have a local path');
      const fileContent = readFileSync(downloadPath, 'utf8');
      assert.equal(fileContent, expectedMarkdown);
      assert.equal(download.suggestedFilename(), 'dsh-community-feedback-draft.md');

      // Closing keeps the draft; reopening resumes it from the host.
      await page.click('[data-testid="dsh-feedback-close"]');
      await page.waitForSelector('[data-testid="dsh-feedback-workspace"]', { state: 'detached', timeout: 10_000 });
      await page.click('[data-testid="dsh-feedback-trigger"]');
      await page.waitForSelector('[data-testid="dsh-feedback-workspace"]', { timeout: 10_000 });
      await waitForRestored(page);
      assert.equal(await page.inputValue('[data-testid="dsh-feedback-title"]'), 'Add a plugin API to Harness');

      // Cancelling asks for a clear confirmation; confirming the discard
      // removes the draft and reopening starts a blank session.
      await page.click('[data-testid="dsh-feedback-cancel"]');
      await page.waitForSelector('[data-testid="dsh-feedback-discard-confirm"]', { timeout: 10_000 });
      await page.click('[data-testid="dsh-feedback-discard-confirm-action"]');
      await page.waitForSelector('[data-testid="dsh-feedback-workspace"]', { state: 'detached', timeout: 10_000 });
      await page.click('[data-testid="dsh-feedback-trigger"]');
      await page.waitForSelector('[data-testid="dsh-feedback-workspace"]', { timeout: 10_000 });
      assert.equal(await page.inputValue('[data-testid="dsh-feedback-title"]'), '');

      await browser.close();

      // Zero GitHub writes and zero external requests across the whole flow.
      const external = requests.filter((url) => {
        const host = new URL(url).hostname;
        return host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]';
      });
      assert.deepEqual(external, [], `unexpected external requests: ${external.join(', ')}`);
      assert.ok(!requests.some((url) => /github\.com/i.test(url)), 'a GitHub request was observed during the feedback flow');
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise((resolveExit) => child.once('exit', resolveExit));
      }
    }
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
    rmSync(tarballPath, { force: true });
  }
});
test('draft autosaves, survives a page reload, resumes, exports, and a confirmed discard removes it with zero external requests', { skip: !hasDsh || !hasPnpm || !hasPlaywrightCore }, async () => {
  const { chromium } = await import('playwright-core');
  const { existsSync } = await import('node:fs');
  const tarball = packFilename(repoRoot);
  const tarballPath = join(repoRoot, tarball);
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-feedback-bridge-reload-'));
  const draftPath = join(dshHome, 'dsh-feedback-bridge', 'draft.json');

  try {
    run('dsh', ['plugin', '--profile', 'web', 'add', tarballPath], {
      cwd: repoRoot,
      env: { ...process.env, DSH_HOME: dshHome },
    });

    const cleanEnv = { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_MODE: 'DISABLED' };
    delete cleanEnv.DSH_VERSION;

    const child = spawn('dsh', ['--profile', 'web', '--no-open', '--port', '0'], {
      cwd: repoRoot,
      env: cleanEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const port = await new Promise((resolvePort, reject) => {
      let stdout = '';
      const timeout = setTimeout(() => reject(new Error(`dsh web did not print a URL; stderr: ${stderr}`)), 30_000);
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
        if (match !== null) {
          clearTimeout(timeout);
          resolvePort(Number(match[1]));
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`dsh web exited before printing a URL (code ${code}); stderr: ${stderr}`));
      });
    });
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const requests = [];
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ acceptDownloads: true });
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl });
      const page = await context.newPage();
      page.on('request', (request) => requests.push(request.url()));
      page.on('websocket', (socket) => requests.push(socket.url()));

      const openWorkspace = async () => {
        await page.click('[data-testid="dsh-feedback-trigger"]');
        await page.waitForSelector('[data-testid="dsh-feedback-workspace"]', { timeout: 30_000 });
      };

      // Fill the draft and wait for the debounced autosave to land on disk.
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunModals(page);
      await page.waitForSelector('[data-testid="dsh-feedback-trigger"]', { timeout: 60_000 });
      await openWorkspace();
      await page.fill('[data-testid="dsh-feedback-title"]', 'Resumable draft title');
      await page.fill('[data-testid="dsh-feedback-scenario"]', 'A scenario written before the reload.');
      await waitForFile(draftPath, () => existsSync(draftPath) && readFileSync(draftPath, 'utf8').includes('Resumable draft title'));

      // Reload: the page must restore the persisted draft.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await dismissFirstRunModals(page);
      await page.waitForSelector('[data-testid="dsh-feedback-trigger"]', { timeout: 60_000 });
      await openWorkspace();
      await waitForRestored(page);
      assert.equal(await page.inputValue('[data-testid="dsh-feedback-title"]'), 'Resumable draft title');
      assert.equal(await page.inputValue('[data-testid="dsh-feedback-scenario"]'), 'A scenario written before the reload.');

      // Continue editing after the resume, then copy and export the exact
      // Markdown including the resumed content.
      await page.fill('[data-testid="dsh-feedback-gap"]', 'A gap added after the resume.');
      await page.fill('[data-testid="dsh-feedback-desired"]', 'Desired result after the resume.');
      const expectedMarkdown = [
        '# Resumable draft title',
        '',
        '## Scenario',
        '',
        'A scenario written before the reload.',
        '',
        '## The problem or situation you encountered',
        '',
        'A gap added after the resume.',
        '',
        '## Desired result',
        '',
        'Desired result after the resume.',
      ].join('\n');
      assert.equal((await page.textContent('[data-testid="dsh-feedback-preview"]')).trim(), expectedMarkdown);

      await page.click('[data-testid="dsh-feedback-copy"]');
      await page.waitForSelector('[data-testid="dsh-feedback-notice"]', { timeout: 10_000 });
      assert.equal((await page.evaluate(() => navigator.clipboard.readText())), expectedMarkdown);

      const downloadPromise = page.waitForEvent('download');
      await page.click('[data-testid="dsh-feedback-export"]');
      const download = await downloadPromise;
      assert.equal(readFileSync(await download.path(), 'utf8'), expectedMarkdown);
      assert.equal(download.suggestedFilename(), 'dsh-community-feedback-draft.md');

      // Closing keeps the draft; reopening resumes it from the host.
      await page.click('[data-testid="dsh-feedback-close"]');
      await page.waitForSelector('[data-testid="dsh-feedback-workspace"]', { state: 'detached', timeout: 10_000 });
      await openWorkspace();
      await waitForRestored(page);
      assert.equal(await page.inputValue('[data-testid="dsh-feedback-title"]'), 'Resumable draft title');

      // Cancel shows the explicit confirmation; "Keep editing" changes nothing.
      await page.click('[data-testid="dsh-feedback-cancel"]');
      await page.waitForSelector('[data-testid="dsh-feedback-discard-confirm"]', { timeout: 10_000 });
      await page.click('[data-testid="dsh-feedback-discard-keep"]');
      await page.waitForSelector('[data-testid="dsh-feedback-discard-confirm"]', { state: 'detached', timeout: 10_000 });
      assert.equal(await page.inputValue('[data-testid="dsh-feedback-title"]'), 'Resumable draft title');

      // Confirming the discard removes the draft file and the workspace closes.
      await page.click('[data-testid="dsh-feedback-cancel"]');
      await page.waitForSelector('[data-testid="dsh-feedback-discard-confirm"]', { timeout: 10_000 });
      await page.click('[data-testid="dsh-feedback-discard-confirm-action"]');
      await page.waitForSelector('[data-testid="dsh-feedback-workspace"]', { state: 'detached', timeout: 10_000 });
      await waitForFile(draftPath, () => !existsSync(draftPath));

      // A late autosave must not resurrect the discarded draft.
      await page.waitForTimeout(1500);
      assert.equal(existsSync(draftPath), false, 'a discarded draft must stay removed');

      // Reopening starts a blank session.
      await openWorkspace();
      assert.equal(await page.inputValue('[data-testid="dsh-feedback-title"]'), '');

      await browser.close();

      const external = requests.filter((url) => {
        const host = new URL(url).hostname;
        return host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]';
      });
      assert.deepEqual(external, [], `unexpected external requests: ${external.join(', ')}`);
      assert.ok(!requests.some((url) => /github\.com/i.test(url)), 'a GitHub request was observed during the feedback flow');
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise((resolveExit) => child.once('exit', resolveExit));
      }
    }
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
    rmSync(tarballPath, { force: true });
  }
});


test('user-approved conversation sources drive the exported draft: sentinel isolation, removal semantics and zero external requests', { skip: !hasDsh || !hasPnpm || !hasPlaywrightCore }, async () => {
  const { chromium } = await import('playwright-core');
  const { existsSync } = await import('node:fs');
  const tarball = packFilename(repoRoot);
  const tarballPath = join(repoRoot, tarball);
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-feedback-bridge-sources-'));
  const draftPath = join(dshHome, 'dsh-feedback-bridge', 'draft.json');

  /** Wait until the composer textarea is editable (workspace attached). */
  async function waitForComposer(page) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const ta = page.locator('textarea').last();
      if ((await ta.count()) && (await ta.getAttribute('readonly')) === null) return ta;
      await page.waitForTimeout(500);
    }
    throw new Error('composer never became editable');
  }

  /** Send one prompt through the composer and wait for its admission. */
  async function sendMessage(page, ta, text) {
    await ta.click();
    await ta.fill(text);
    await page.keyboard.press('Enter');
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if ((await page.locator('body').innerText()).includes(text)) return;
      await page.waitForTimeout(500);
    }
    throw new Error('message was not admitted: ' + text);
  }

  try {
    run('dsh', ['plugin', '--profile', 'web', 'add', tarballPath], {
      cwd: repoRoot,
      env: { ...process.env, DSH_HOME: dshHome },
    });

    const cleanEnv = { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_MODE: 'DISABLED' };
    delete cleanEnv.DSH_VERSION;

    const child = spawn('dsh', ['--profile', 'web', '--no-open', '--port', '0'], {
      cwd: repoRoot,
      env: cleanEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const port = await new Promise((resolvePort, reject) => {
      let stdout = '';
      const timeout = setTimeout(() => reject(new Error('dsh web did not print a URL; stderr: ' + stderr)), 30_000);
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
        if (match !== null) {
          clearTimeout(timeout);
          resolvePort(Number(match[1]));
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error('dsh web exited before printing a URL (code ' + code + '); stderr: ' + stderr));
      });
    });
    const baseUrl = 'http://127.0.0.1:' + port;

    try {
      const requests = [];
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ acceptDownloads: true });
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl });
      const page = await context.newPage();
      page.on('request', (request) => requests.push(request.url()));
      page.on('websocket', (socket) => requests.push(socket.url()));

      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunModals(page);
      await page.waitForSelector('[data-testid="dsh-feedback-trigger"]', { timeout: 60_000 });

      // Pick a workspace so the session composer becomes editable.
      await page.getByRole('button', { name: 'Choose workspace' }).first().click();
      await page.waitForSelector('[role="dialog"]:visible', { timeout: 15_000 });
      const dialog = page.locator('[role="dialog"]:visible').first();
      const testRow = dialog.getByText('test', { exact: true }).first();
      if (await testRow.count()) {
        await testRow.click();
      } else {
        const controls = new Set(['New folder', 'Show hidden files', 'Cancel', 'Open']);
        const rows = dialog.locator('[role="button"]');
        let picked = false;
        for (let i = 0; i < await rows.count(); i += 1) {
          const text = (await rows.nth(i).innerText()).trim();
          if (!controls.has(text) && text !== '') {
            await rows.nth(i).click();
            picked = true;
            break;
          }
        }
        if (!picked) throw new Error('no directory row found in the workspace picker');
      }
      await dialog.getByRole('button', { name: 'Open' }).click();

      // Compose a conversation carrying the sentinel material.
      const ta = await waitForComposer(page);
      await sendMessage(page, ta, 'SENTINEL_UNSELECTED 这个需求我已经想清楚了');
      await sendMessage(page, page.locator('textarea').last(), 'SENTINEL_RECOMMENDED 之前的 error 让插件崩了');
      await sendMessage(page, page.locator('textarea').last(), 'SENTINEL_REVIEWED 我遇到了 error 报错：插件无法加载');
      // Recommended (error keyword) but never confirmed: must never export.
      await sendMessage(page, page.locator('textarea').last(), 'SENTINEL_RECOMMENDED_ONLY 这个 error 情况也需要关注');

      // The failing turn surfaces real diagnostic context in the transcript.
      const errorDeadline = Date.now() + 30_000;
      while (Date.now() < errorDeadline) {
        if ((await page.locator('body').innerText()).includes('MISSING_CREDENTIAL')) break;
        await page.waitForTimeout(500);
      }

      // Open the feedback workspace and inspect the sources panel.
      await page.click('[data-testid="dsh-feedback-trigger"]');
      await page.waitForSelector('[data-testid="dsh-feedback-workspace"]', { timeout: 30_000 });
      await page.waitForSelector('[data-testid="dsh-feedback-sources"]', { timeout: 15_000 });

      const panelText = await page.locator('[data-testid="dsh-feedback-sources"]').innerText();
      assert.match(panelText, /SENTINEL_UNSELECTED/);
      assert.match(panelText, /SENTINEL_RECOMMENDED/);
      assert.match(panelText, /SENTINEL_RECOMMENDED_ONLY/);
      assert.match(panelText, /SENTINEL_REVIEWED/);
      assert.match(panelText, /Recommended/);
      // The failed turn is diagnostic candidate material.
      assert.match(panelText, /This turn failed|MISSING_CREDENTIAL|运行错误/);

      // Nothing is selected by default.
      assert.equal(await page.locator('[data-testid="dsh-feedback-source-remove"]').count(), 0);

      // Confirm the reviewed source and quote its reviewed snapshot into the scenario field.
      const reviewedRow = page.locator('[data-testid^="dsh-feedback-source-"]').filter({ hasText: 'SENTINEL_REVIEWED' }).first();
      await reviewedRow.locator('[data-testid="dsh-feedback-source-confirm"]').click();
      await page.waitForTimeout(300);
      const confirmedReviewed = page.locator('[data-testid^="dsh-feedback-confirmed-"]').filter({ hasText: 'SENTINEL_REVIEWED' }).first();
      await confirmedReviewed.locator('select').selectOption('scenario');

      // Confirm then remove a second source: it must stop feeding the draft.
      const recommendedRow = page.locator('[data-testid^="dsh-feedback-source-"]').filter({ hasText: 'SENTINEL_RECOMMENDED' }).first();
      await recommendedRow.locator('[data-testid="dsh-feedback-source-confirm"]').click();
      await page.waitForTimeout(300);
      const confirmedRecommended = page.locator('[data-testid^="dsh-feedback-confirmed-"]').filter({ hasText: 'SENTINEL_RECOMMENDED' }).first();
      await confirmedRecommended.locator('[data-testid="dsh-feedback-source-remove"]').click();
      await page.waitForTimeout(300);

      // Fill the public title; the preview must contain only reviewed content.
      await page.fill('[data-testid="dsh-feedback-title"]', 'Sentinel isolation test');
      await page.waitForTimeout(1200); // let the debounced autosave land
      const preview = (await page.textContent('[data-testid="dsh-feedback-preview"]')).trim();
      assert.match(preview, /# Sentinel isolation test/);
      assert.match(preview, /SENTINEL_REVIEWED/);
      assert.doesNotMatch(preview, /SENTINEL_UNSELECTED/);
      assert.doesNotMatch(preview, /SENTINEL_RECOMMENDED/);
      assert.doesNotMatch(preview, /SENTINEL_RECOMMENDED_ONLY/);
      assert.doesNotMatch(preview, /MISSING_CREDENTIAL|This turn failed/);

      // The exported file carries exactly the reviewed public draft.
      const downloadPromise = page.waitForEvent('download');
      await page.click('[data-testid="dsh-feedback-export"]');
      const download = await downloadPromise;
      const exported = readFileSync(await download.path(), 'utf8');
      assert.match(exported, /# Sentinel isolation test/);
      assert.match(exported, /SENTINEL_REVIEWED/);
      assert.doesNotMatch(exported, /SENTINEL_UNSELECTED/);
      assert.doesNotMatch(exported, /SENTINEL_RECOMMENDED/);
      assert.doesNotMatch(exported, /SENTINEL_RECOMMENDED_ONLY/);
      assert.doesNotMatch(exported, /MISSING_CREDENTIAL|This turn failed/);

      // The persisted draft keeps only confirmed sources at schema v2.
      await waitForFile(draftPath, () => existsSync(draftPath) && readFileSync(draftPath, 'utf8').includes('SENTINEL_REVIEWED'));
      const persisted = readFileSync(draftPath, 'utf8');
      assert.match(persisted, /"version": 3/);
      assert.match(persisted, /SENTINEL_REVIEWED/);
      assert.doesNotMatch(persisted, /SENTINEL_RECOMMENDED/);
      assert.doesNotMatch(persisted, /SENTINEL_RECOMMENDED_ONLY/);
      assert.doesNotMatch(persisted, /SENTINEL_UNSELECTED/);

      await browser.close();

      // Zero external requests and zero GitHub traffic across the whole flow.
      const external = requests.filter((url) => {
        const host = new URL(url).hostname;
        return host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]';
      });
      assert.deepEqual(external, [], 'unexpected external requests: ' + external.join(', '));
      assert.ok(!requests.some((url) => /github\.com/i.test(url)), 'a GitHub request was observed during the feedback flow');
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise((resolveExit) => child.once('exit', resolveExit));
      }
    }
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
    rmSync(tarballPath, { force: true });
  }
});

test('draft survives a DSH restart with the same DSH_HOME on a different port', { skip: !hasDsh || !hasPnpm || !hasPlaywrightCore }, async () => {
  const { chromium } = await import('playwright-core');
  const { existsSync } = await import('node:fs');
  const tarball = packFilename(repoRoot);
  const tarballPath = join(repoRoot, tarball);
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-feedback-bridge-restart-'));
  const draftPath = join(dshHome, 'dsh-feedback-bridge', 'draft.json');

  async function boot() {
    const child = spawn('dsh', ['--profile', 'web', '--no-open', '--port', '0'], {
      cwd: repoRoot,
      env: { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_MODE: 'DISABLED' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const port = await new Promise((resolvePort, reject) => {
      let stdout = '';
      const timeout = setTimeout(() => reject(new Error(`dsh web did not print a URL; stderr: ${stderr}`)), 30_000);
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
        if (match !== null) {
          clearTimeout(timeout);
          resolvePort(Number(match[1]));
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`dsh web exited before printing a URL (code ${code}); stderr: ${stderr}`));
      });
    });
    return { child, port };
  }

  async function stop(child) {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolveExit) => child.once('exit', resolveExit));
    }
  }

  try {
    run('dsh', ['plugin', '--profile', 'web', 'add', tarballPath], {
      cwd: repoRoot,
      env: { ...process.env, DSH_HOME: dshHome },
    });

    // First boot: write a draft and wait for the autosave to land.
    const first = await boot();
    const firstUrl = `http://127.0.0.1:${first.port}`;
    const browser = await chromium.launch({ headless: true });
    const firstContext = await browser.newContext({ acceptDownloads: true });
    const firstPage = await firstContext.newPage();
    try {
      await firstPage.goto(firstUrl, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunModals(firstPage);
      await firstPage.waitForSelector('[data-testid="dsh-feedback-trigger"]', { timeout: 60_000 });
      await firstPage.click('[data-testid="dsh-feedback-trigger"]');
      await firstPage.waitForSelector('[data-testid="dsh-feedback-workspace"]', { timeout: 30_000 });
      await firstPage.fill('[data-testid="dsh-feedback-title"]', 'Survives a restart');
      await firstPage.fill('[data-testid="dsh-feedback-scenario"]', 'This draft must come back after DSH restarts.');
      await waitForFile(draftPath, () => existsSync(draftPath) && readFileSync(draftPath, 'utf8').includes('Survives a restart'));
    } finally {
      await browser.close();
      await stop(first.child);
    }

    // Second boot with the same DSH_HOME picks a different port and restores
    // the draft.
    const second = await boot();
    const secondUrl = `http://127.0.0.1:${second.port}`;
    assert.notEqual(second.port, first.port);
    const secondBrowser = await chromium.launch({ headless: true });
    const secondContext = await secondBrowser.newContext({ acceptDownloads: true });
    const secondPage = await secondContext.newPage();
    try {
      await secondPage.goto(secondUrl, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunModals(secondPage);
      await secondPage.waitForSelector('[data-testid="dsh-feedback-trigger"]', { timeout: 60_000 });
      await secondPage.click('[data-testid="dsh-feedback-trigger"]');
      await secondPage.waitForSelector('[data-testid="dsh-feedback-workspace"]', { timeout: 30_000 });
      await waitForRestored(secondPage);
      assert.equal(await secondPage.inputValue('[data-testid="dsh-feedback-title"]'), 'Survives a restart');
      assert.equal(await secondPage.inputValue('[data-testid="dsh-feedback-scenario"]'), 'This draft must come back after DSH restarts.');
    } finally {
      await secondBrowser.close();
      await stop(second.child);
    }
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
    rmSync(tarballPath, { force: true });
  }
});


// ---------------------------------------------------------------------------
// Issue #6: model-assisted drafting — real path and fake-backed paths
// ---------------------------------------------------------------------------

/** Boot a fresh DSH Web profile and resolve its URL. */
async function bootWeb(env) {
  const child = spawn('dsh', ['--profile', 'web', '--no-open', '--port', '0'], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const port = await new Promise((resolvePort, reject) => {
    let stdout = '';
    const timeout = setTimeout(() => reject(new Error('dsh web did not print a URL; stderr: ' + stderr)), 30_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
      if (match !== null) {
        clearTimeout(timeout);
        resolvePort(Number(match[1]));
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error('dsh web exited before printing a URL (code ' + code + '); stderr: ' + stderr));
    });
  });
  return { child, port, stderr };
}

/** Stop a spawned dsh web process. */
async function stopWeb(child) {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolveExit) => child.once('exit', resolveExit));
  }
}

/** Wait until a selector's text satisfies a predicate or the timeout expires. */
async function waitForText(page, selector, predicate, { timeoutMs = 20_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const el = page.locator(selector).first();
    if (await el.count()) {
      const text = (await el.innerText()).trim();
      if (predicate(text)) return text;
    }
    await page.waitForTimeout(intervalMs);
  }
  throw new Error('timed out waiting for ' + selector);
}

/** Wait until the composer textarea is editable. */
async function waitForComposerInput(page) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ta = page.locator('textarea').last();
    if ((await ta.count()) && (await ta.getAttribute('readonly')) === null) return ta;
    await page.waitForTimeout(500);
  }
  throw new Error('composer never became editable');
}

/** Send one prompt through the composer and wait for its admission. */
async function sendPrompt(page, ta, text) {
  await ta.click();
  await ta.fill(text);
  await page.keyboard.press('Enter');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if ((await page.locator('body').innerText()).includes(text)) return;
    await page.waitForTimeout(500);
  }
  throw new Error('message was not admitted: ' + text);
}

/** Choose a workspace so the session composer becomes editable. */
async function chooseWorkspace(page) {
  await page.getByRole('button', { name: 'Choose workspace' }).first().click();
  await page.waitForSelector('[role="dialog"]:visible', { timeout: 15_000 });
  const dialog = page.locator('[role="dialog"]:visible').first();
  const testRow = dialog.getByText('test', { exact: true }).first();
  if (await testRow.count()) {
    await testRow.click();
  } else {
    const controls = new Set(['New folder', 'Show hidden files', 'Cancel', 'Open']);
    const rows = dialog.locator('[role="button"]');
    let picked = false;
    for (let i = 0; i < await rows.count(); i += 1) {
      const text = (await rows.nth(i).innerText()).trim();
      if (!controls.has(text) && text !== '') {
        await rows.nth(i).click();
        picked = true;
        break;
      }
    }
    if (!picked) throw new Error('no directory row found in the workspace picker');
  }
  await dialog.getByRole('button', { name: 'Open' }).click();
}

/** Write the fake-llm fixture mode and response for the next assist call. */
function writeFakeLlm(dshHome, mode, text) {
  const dir = join(dshHome, 'dsh-feedback-bridge-test', 'fake-llm');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'mode'), mode, 'utf8');
  writeFileSync(join(dir, 'response.txt'), text, 'utf8');
}

/** A known-good structured fake model response. */
const FAKE_SUGGESTION = JSON.stringify({
  type: 'harness-defect',
  typeReason: 'The confirmed source describes an observable harness failure.',
  missingInfo: [{ field: 'reproduction', reason: 'Reproduction steps are missing.', importance: 'high' }],
  draft: {
    title: 'Harness crashes on plugin load',
    scenario: 'Loading a plugin crashes the harness.',
    gap: 'The harness exits without an error message.',
    desired: 'The harness should stay running.',
    context: 'SENTINEL_REVIEWED summary.',
  },
  privacyFindings: [],
});

test('model-assist on a real Web profile without credentials fails gracefully and preserves user content', { skip: !hasDsh || !hasPnpm || !hasPlaywrightCore }, async () => {
  const { chromium } = await import('playwright-core');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tarball = packFilename(repoRoot);
  const tarballPath = join(repoRoot, tarball);
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-feedback-bridge-assist-real-'));

  try {
    run('dsh', ['plugin', '--profile', 'web', 'add', tarballPath], {
      cwd: repoRoot,
      env: { ...process.env, DSH_HOME: dshHome },
    });
    const cleanEnv = { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_MODE: 'DISABLED' };
    delete cleanEnv.DSH_VERSION;
    const { child, port } = await bootWeb(cleanEnv);
    const baseUrl = 'http://127.0.0.1:' + port;

    try {
      const requests = [];
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ acceptDownloads: true });
      const page = await context.newPage();
      page.on('request', (request) => requests.push(request.url()));
      page.on('websocket', (socket) => requests.push(socket.url()));

      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunModals(page);
      await page.waitForSelector('[data-testid="dsh-feedback-trigger"]', { timeout: 60_000 });
      await chooseWorkspace(page);
      const ta = await waitForComposerInput(page);
      await sendPrompt(page, ta, 'SENTINEL_REVIEWED 我遇到了 error：插件加载崩溃');
      const errorDeadline = Date.now() + 30_000;
      while (Date.now() < errorDeadline) {
        if ((await page.locator('body').innerText()).includes('MISSING_CREDENTIAL')) break;
        await page.waitForTimeout(500);
      }

      await page.click('[data-testid="dsh-feedback-trigger"]');
      await page.waitForSelector('[data-testid="dsh-feedback-workspace"]', { timeout: 30_000 });
      const reviewedRow = page.locator('[data-testid^="dsh-feedback-source-"]').filter({ hasText: 'SENTINEL_REVIEWED' }).first();
      await reviewedRow.locator('[data-testid="dsh-feedback-source-confirm"]').click();
      await page.waitForTimeout(300);

      // Generate through the real llm seam: without credentials the call must
      // degrade to a distinct model-failed state and never touch user content.
      await page.click('[data-testid="dsh-feedback-assist-run"]');
      await waitForText(page, '[data-testid="dsh-feedback-assist-error"]', () => true);

      assert.equal(await page.inputValue('[data-testid="dsh-feedback-title"]'), '');
      assert.ok(await page.locator('[data-testid^="dsh-feedback-confirmed-"]').count() >= 1);

      await browser.close();
      const external = requests.filter((url) => {
        const host = new URL(url).hostname;
        return host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]';
      });
      assert.deepEqual(external, [], 'unexpected external requests: ' + external.join(', '));
    } finally {
      await stopWeb(child);
    }
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
    rmSync(tarballPath, { force: true });
  }
});

test('fake-backed model-assist: suggestions apply only on explicit action, unconfirmed sentinels never reach the model, and type override stays authoritative', { skip: !hasDsh || !hasPnpm || !hasPlaywrightCore }, async () => {
  const { chromium } = await import('playwright-core');
  const { mkdtempSync, rmSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tarball = packFilename(repoRoot);
  const tarballPath = join(repoRoot, tarball);
  const fakeTarball = packFilename(join(repoRoot, 'test', 'fixtures', 'fake-llm'));
  const fakeTarballPath = join(repoRoot, 'test', 'fixtures', 'fake-llm', fakeTarball);
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-feedback-bridge-assist-fake-'));

  try {
    run('dsh', ['plugin', '--profile', 'web', 'add', tarballPath], {
      cwd: repoRoot,
      env: { ...process.env, DSH_HOME: dshHome },
    });
    run('dsh', ['plugin', '--profile', 'web', 'add', fakeTarballPath], {
      cwd: repoRoot,
      env: { ...process.env, DSH_HOME: dshHome },
    });
    const cleanEnv = { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_MODE: 'DISABLED' };
    delete cleanEnv.DSH_VERSION;
    const { child, port } = await bootWeb(cleanEnv);
    const baseUrl = 'http://127.0.0.1:' + port;

    try {
      const requests = [];
      const assistBodies = [];
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ acceptDownloads: true });
      const page = await context.newPage();
      page.on('request', (request) => {
        requests.push(request.url());
        if (request.url().includes('/dsh-feedback-bridge/assist')) {
          assistBodies.push(request.postData() ?? '');
        }
      });
      page.on('websocket', (socket) => requests.push(socket.url()));

      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunModals(page);
      await page.waitForSelector('[data-testid="dsh-feedback-trigger"]', { timeout: 60_000 });
      await chooseWorkspace(page);
      const ta = await waitForComposerInput(page);
      await sendPrompt(page, ta, 'SENTINEL_UNSELECTED 无关内容');
      await sendPrompt(page, page.locator('textarea').last(), 'SENTINEL_REVIEWED 我遇到了 error：插件加载崩溃');
      const errorDeadline = Date.now() + 30_000;
      while (Date.now() < errorDeadline) {
        if ((await page.locator('body').innerText()).includes('MISSING_CREDENTIAL')) break;
        await page.waitForTimeout(500);
      }

      await page.click('[data-testid="dsh-feedback-trigger"]');
      await page.waitForSelector('[data-testid="dsh-feedback-workspace"]', { timeout: 30_000 });
      const reviewedRow = page.locator('[data-testid^="dsh-feedback-source-"]').filter({ hasText: 'SENTINEL_REVIEWED' }).first();
      await reviewedRow.locator('[data-testid="dsh-feedback-source-confirm"]').click();
      await page.waitForTimeout(300);

      // The fake model returns a valid structured response.
      writeFakeLlm(dshHome, 'ok', FAKE_SUGGESTION);
      await page.click('[data-testid="dsh-feedback-assist-run"]');
      await waitForText(page, '[data-testid="dsh-feedback-assist-result"]', () => true);

      // The recommendation badge shows the model's type while custom stays selected.
      const recommendation = await waitForText(page, '[data-testid="dsh-feedback-type-recommendation"]', () => true);
      assert.match(recommendation, /Harness defect report/);
      assert.equal(await page.inputValue('[data-testid="dsh-feedback-type-select"]'), 'custom');
      assert.match(await page.locator('[data-testid="dsh-feedback-assist-missing"]').innerText(), /Reproduction steps are missing/);

      // The assist request body carried only the confirmed source snapshot:
      // the unconfirmed sentinel never reaches the model.
      assert.ok(assistBodies.length >= 1, 'an assist request must have been made');
      assert.match(assistBodies[0], /SENTINEL_REVIEWED/);
      assert.doesNotMatch(assistBodies[0], /SENTINEL_UNSELECTED/);

      // Nothing was applied automatically: the public title is still empty.
      assert.equal(await page.inputValue('[data-testid="dsh-feedback-title"]'), '');
      assert.doesNotMatch((await page.textContent('[data-testid="dsh-feedback-preview"]')).trim(), /Harness crashes on plugin load/);

      // Applying the suggested title is an explicit action that updates the public draft.
      await page.click('[data-testid="dsh-feedback-assist-apply-title"]');
      await page.waitForTimeout(300);
      assert.equal(await page.inputValue('[data-testid="dsh-feedback-title"]'), 'Harness crashes on plugin load');
      assert.match((await page.textContent('[data-testid="dsh-feedback-preview"]')).trim(), /# Harness crashes on plugin load/);

      // The user overrides the type; the recommendation stays visible as a suggestion.
      await page.selectOption('[data-testid="dsh-feedback-type-select"]', 'harness-feature');
      assert.match(await page.locator('[data-testid="dsh-feedback-type-recommendation"]').innerText(), /Harness defect report/);

      // The exported file carries the applied public content and no unconfirmed sentinel.
      const downloadPromise = page.waitForEvent('download');
      await page.click('[data-testid="dsh-feedback-export"]');
      const download = await downloadPromise;
      const exported = readFileSync(await download.path(), 'utf8');
      assert.match(exported, /# Harness crashes on plugin load/);
      assert.doesNotMatch(exported, /SENTINEL_UNSELECTED/);

      await browser.close();
      const external = requests.filter((url) => {
        const host = new URL(url).hostname;
        return host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]';
      });
      assert.deepEqual(external, [], 'unexpected external requests: ' + external.join(', '));
      assert.ok(!requests.some((url) => /github\.com/i.test(url)), 'a GitHub request was observed');
    } finally {
      await stopWeb(child);
    }
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
    rmSync(tarballPath, { force: true });
    rmSync(fakeTarballPath, { force: true });
  }
});

test('fake-backed model-assist: malformed output enters the repair panel and revalidates locally, failures retry, and privacy findings never rewrite content', { skip: !hasDsh || !hasPnpm || !hasPlaywrightCore }, async () => {
  const { chromium } = await import('playwright-core');
  const { mkdtempSync, rmSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tarball = packFilename(repoRoot);
  const tarballPath = join(repoRoot, tarball);
  const fakeTarball = packFilename(join(repoRoot, 'test', 'fixtures', 'fake-llm'));
  const fakeTarballPath = join(repoRoot, 'test', 'fixtures', 'fake-llm', fakeTarball);
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-feedback-bridge-assist-repair-'));

  try {
    run('dsh', ['plugin', '--profile', 'web', 'add', tarballPath], {
      cwd: repoRoot,
      env: { ...process.env, DSH_HOME: dshHome },
    });
    run('dsh', ['plugin', '--profile', 'web', 'add', fakeTarballPath], {
      cwd: repoRoot,
      env: { ...process.env, DSH_HOME: dshHome },
    });
    const cleanEnv = { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_MODE: 'DISABLED' };
    delete cleanEnv.DSH_VERSION;
    const { child, port } = await bootWeb(cleanEnv);
    const baseUrl = 'http://127.0.0.1:' + port;

    try {
      const requests = [];
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ acceptDownloads: true });
      const page = await context.newPage();
      page.on('request', (request) => requests.push(request.url()));
      page.on('websocket', (socket) => requests.push(socket.url()));

      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunModals(page);
      await page.waitForSelector('[data-testid="dsh-feedback-trigger"]', { timeout: 60_000 });
      await chooseWorkspace(page);
      const ta = await waitForComposerInput(page);
      await sendPrompt(page, ta, 'SENTINEL_REVIEWED 我遇到了 error：插件加载崩溃');
      const errorDeadline = Date.now() + 30_000;
      while (Date.now() < errorDeadline) {
        if ((await page.locator('body').innerText()).includes('MISSING_CREDENTIAL')) break;
        await page.waitForTimeout(500);
      }

      await page.click('[data-testid="dsh-feedback-trigger"]');
      await page.waitForSelector('[data-testid="dsh-feedback-workspace"]', { timeout: 30_000 });
      const reviewedRow = page.locator('[data-testid^="dsh-feedback-source-"]').filter({ hasText: 'SENTINEL_REVIEWED' }).first();
      await reviewedRow.locator('[data-testid="dsh-feedback-source-confirm"]').click();
      await page.waitForTimeout(300);

      // Malformed output opens the repair panel with the raw text preserved.
      writeFakeLlm(dshHome, 'ok', 'this is not json at all');
      await page.click('[data-testid="dsh-feedback-assist-run"]');
      await waitForText(page, '[data-testid="dsh-feedback-assist-repair"]', () => true);
      assert.equal(await page.inputValue('[data-testid="dsh-feedback-assist-repair-text"]'), 'this is not json at all');
      // Validation errors render as localized text; no raw error code leaks.
      assert.doesNotMatch(await page.locator('[data-testid="dsh-feedback-assist-repair"]').innerText(), /assist\.error\./);

      // Editing the raw text to a valid response and re-validating recovers locally.
      await page.fill('[data-testid="dsh-feedback-assist-repair-text"]', FAKE_SUGGESTION);
      await page.click('[data-testid="dsh-feedback-assist-revalidate"]');
      await waitForText(page, '[data-testid="dsh-feedback-assist-result"]', () => true);
      assert.match(await page.locator('[data-testid="dsh-feedback-type-recommendation"]').innerText(), /Harness defect report/);

      // A provider failure surfaces a distinct state; retry after recovery works.
      writeFakeLlm(dshHome, 'fail', '');
      await page.click('[data-testid="dsh-feedback-assist-run"]');
      await waitForText(page, '[data-testid="dsh-feedback-assist-error"]', (text) => text.includes('RATE_LIMIT'));
      writeFakeLlm(dshHome, 'ok', FAKE_SUGGESTION);
      await page.click('[data-testid="dsh-feedback-assist-retry"]');
      await waitForText(page, '[data-testid="dsh-feedback-assist-result"]', () => true);

      // Privacy findings are advisory: a credential marker in a public field is
      // flagged but the exported content keeps the text verbatim.
      await page.fill('[data-testid="dsh-feedback-gap"]', 'the api key is sk-abcdef1234567890xyz');
      await page.waitForTimeout(300);
      await waitForText(page, '[data-testid="dsh-feedback-privacy"]', () => true);
      // Export requires a non-empty title; the credential marker must survive
      // the flow verbatim.
      await page.fill('[data-testid="dsh-feedback-title"]', 'Privacy advisory test');
      await page.waitForTimeout(300);
      const downloadPromise = page.waitForEvent('download');
      await page.click('[data-testid="dsh-feedback-export"]');
      const download = await downloadPromise;
      const exported = readFileSync(await download.path(), 'utf8');
      assert.match(exported, /the api key is sk-abcdef1234567890xyz/);

      await browser.close();
      const external = requests.filter((url) => {
        const host = new URL(url).hostname;
        return host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]';
      });
      assert.deepEqual(external, [], 'unexpected external requests: ' + external.join(', '));
    } finally {
      await stopWeb(child);
    }
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
    rmSync(tarballPath, { force: true });
    rmSync(fakeTarballPath, { force: true });
  }
});
