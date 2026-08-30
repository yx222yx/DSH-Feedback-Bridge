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


// Issue #7: early read-only similarity results from the approved sources
// ---------------------------------------------------------------------------

/** Atom fixture with one entry matching the acceptance intent terms. */
const SIMILARITY_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>tag:github.com,2008:3383</id>
    <link type="text/html" rel="alternate" href="https://github.com/deepseek-ai/deepseek-harness/discussions/3383"/>
    <title>Export a plugin draft from a conversation</title>
    <updated>2026-08-30T07:16:44+00:00</updated>
    <content type="html">&lt;p&gt;How do I export a plugin draft?&lt;/p&gt;</content>
  </entry>
  <entry>
    <id>tag:github.com,2008:3384</id>
    <link type="text/html" rel="alternate" href="https://github.com/deepseek-ai/deepseek-harness/discussions/3384"/>
    <title>Unrelated token caps topic</title>
    <updated>2026-08-29T12:00:00+00:00</updated>
    <content type="html">&lt;p&gt;Nothing about exports here.&lt;/p&gt;</content>
  </entry>
</feed>`;

/** npm-registry-shaped payload with one official-scope package. */
const SIMILARITY_NPM = {
  objects: [
    {
      package: {
        name: '@deepseek-ai/dsh-skill',
        description: 'Agent skill provider registry for the DeepSeek Harness',
        links: { repository: 'https://github.com/deepseek-ai/deepseek-harness' },
      },
    },
  ],
};

const SIMILARITY_DOC = '# Architecture\n\nThe DeepSeek Harness plugin architecture supports exporting a plugin draft.\n';

/**
 * Start a local read-only fake source server that serves deterministic
 * fixtures and records every request. The plugin's similarity config points
 * here during acceptance, so the check never touches a real public host.
 */
async function startFakeSources() {
  const { createServer } = await import('node:http');
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    if (req.url === '/atom') {
      res.writeHead(200, { 'content-type': 'application/atom+xml' });
      res.end(SIMILARITY_ATOM);
    } else if (req.url === '/rate-limited-atom') {
      res.writeHead(429, { 'content-type': 'text/plain' });
      res.end('rate limited');
    } else if (req.url !== null && req.url.startsWith('/npm?')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(SIMILARITY_NPM));
    } else if (req.url === '/docs/architecture.md') {
      res.writeHead(200, { 'content-type': 'text/markdown' });
      res.end(SIMILARITY_DOC);
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = 'http://127.0.0.1:' + (address === null || typeof address === 'string' ? '0' : address.port);
  return { server, requests, base };
}

/** The profile patch layer pointing the plugin's similarity sources at the fake server. */
function similarityPatch(base, { rateLimitedAtom = false } = {}) {
  return [
    '- id: dsh-feedback-bridge',
    '  config:',
    '    similarity:',
    '      timeoutMs: 3000',
    '      sources:',
    '        discussions:',
    '          url: ' + base + (rateLimitedAtom ? '/rate-limited-atom' : '/atom'),
    '        plugins:',
    '          url: ' + base + '/npm',
    '        documentation:',
    '          urls:',
    '            - ' + base + '/docs/architecture.md',
    '',
  ].join('\n');
}

test('early similarity results surface from the approved sources read-only, dedupe, and never block export', { skip: !hasDsh || !hasPnpm || !hasPlaywrightCore }, async () => {
  const { chromium } = await import('playwright-core');
  const { mkdtempSync, rmSync, readFileSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tarball = packFilename(repoRoot);
  const tarballPath = join(repoRoot, tarball);
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-feedback-bridge-similarity-'));

  const sources = await startFakeSources();
  try {
    run('dsh', ['plugin', '--profile', 'web', 'add', tarballPath], {
      cwd: repoRoot,
      env: { ...process.env, DSH_HOME: dshHome },
    });
    writeFileSync(join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), similarityPatch(sources.base));
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
      await page.click('[data-testid="dsh-feedback-trigger"]');
      await page.waitForSelector('[data-testid="dsh-feedback-workspace"]', { timeout: 30_000 });

      // The minimum feedback intent: scenario, gap, desired all non-empty.
      await page.fill('[data-testid="dsh-feedback-scenario"]', 'I run a plugin on WSL2');
      await page.fill('[data-testid="dsh-feedback-gap"]', 'I cannot export a plugin draft');
      await page.fill('[data-testid="dsh-feedback-desired"]', 'A documented export plugin flow');

      // The check runs after the debounce and surfaces all three sources.
      await page.waitForSelector('[data-testid="dsh-feedback-similarity-result"]', { timeout: 20_000 });
      const links = await page.locator('[data-testid="dsh-feedback-similarity-link"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')));
      assert.ok(links.some((href) => href.includes('/discussions/3383')), 'discussion result link missing: ' + links.join(', '));
      assert.ok(links.some((href) => href === 'https://github.com/deepseek-ai/deepseek-harness'), 'plugin result link missing');
      assert.ok(links.some((href) => href.endsWith('/docs/architecture.md')), 'documentation result link missing');
      const reason = await page.locator('[data-testid="dsh-feedback-similarity-reason"]').first().innerText();
      assert.match(reason, /export|draft|plugin/);

      // Advisory only: no duplicate verdict and no blocking.
      const panelText = await page.locator('[data-testid="dsh-feedback-similarity"]').innerText();
      assert.doesNotMatch(panelText, /duplicate|重复/i);

      // No repeated search for an unchanged intent: the counts stay put.
      const snapshot = () => sources.requests.filter((request) => request.url.startsWith('/npm?')).length;
      const before = snapshot();
      await page.waitForTimeout(1500);
      assert.equal(snapshot(), before, 'an unchanged intent re-triggered the similarity check');

      // The user continues creating a new Discussion: export still works.
      await page.fill('[data-testid="dsh-feedback-title"]', 'Export a plugin draft');
      const downloadPromise = page.waitForEvent('download');
      await page.click('[data-testid="dsh-feedback-export"]');
      const download = await downloadPromise;
      const exported = readFileSync(await download.path(), 'utf8');
      assert.match(exported, /# Export a plugin draft/);

      await browser.close();
      // Every source request was a read-only GET, and the browser made no
      // external or GitHub requests across the whole flow.
      assert.ok(sources.requests.length >= 3);
      assert.ok(sources.requests.every((request) => request.method === 'GET'), 'a non-GET source request was observed');
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
    sources.server.close();
    rmSync(dshHome, { recursive: true, force: true });
    rmSync(tarballPath, { force: true });
  }
});

test('a rate-limited similarity source is explained without blocking the feedback session', { skip: !hasDsh || !hasPnpm || !hasPlaywrightCore }, async () => {
  const { chromium } = await import('playwright-core');
  const { mkdtempSync, rmSync, readFileSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tarball = packFilename(repoRoot);
  const tarballPath = join(repoRoot, tarball);
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-feedback-bridge-similarity-rate-'));

  const sources = await startFakeSources();
  try {
    run('dsh', ['plugin', '--profile', 'web', 'add', tarballPath], {
      cwd: repoRoot,
      env: { ...process.env, DSH_HOME: dshHome },
    });
    writeFileSync(join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), similarityPatch(sources.base, { rateLimitedAtom: true }));
    const cleanEnv = { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_MODE: 'DISABLED' };
    delete cleanEnv.DSH_VERSION;
    const { child, port } = await bootWeb(cleanEnv);
    const baseUrl = 'http://127.0.0.1:' + port;

    try {
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ acceptDownloads: true });
      const page = await context.newPage();
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunModals(page);
      await page.waitForSelector('[data-testid="dsh-feedback-trigger"]', { timeout: 60_000 });
      await page.click('[data-testid="dsh-feedback-trigger"]');
      await page.waitForSelector('[data-testid="dsh-feedback-workspace"]', { timeout: 30_000 });

      await page.fill('[data-testid="dsh-feedback-scenario"]', 'I run a plugin on WSL2');
      await page.fill('[data-testid="dsh-feedback-gap"]', 'I cannot export a plugin draft');
      await page.fill('[data-testid="dsh-feedback-desired"]', 'A documented export plugin flow');

      // The failed discussion source is explained while the other sources still render.
      await page.waitForSelector('[data-testid="dsh-feedback-similarity-partial"]', { timeout: 20_000 });
      const partial = await page.locator('[data-testid="dsh-feedback-similarity-partial"]').innerText();
      assert.match(partial, /rate limited|限流/);
      assert.ok(await page.locator('[data-testid="dsh-feedback-similarity-retry"]').count(), 'retry control missing');
      assert.ok((await page.locator('[data-testid="dsh-feedback-similarity-result"]').count()) >= 2, 'plugin/docs results missing');

      // The session stays usable: export completes despite the failed source.
      await page.fill('[data-testid="dsh-feedback-title"]', 'Export a plugin draft');
      const downloadPromise = page.waitForEvent('download');
      await page.click('[data-testid="dsh-feedback-export"]');
      const download = await downloadPromise;
      const exported = readFileSync(await download.path(), 'utf8');
      assert.match(exported, /# Export a plugin draft/);
      await browser.close();
    } finally {
      await stopWeb(child);
    }
  } finally {
    sources.server.close();
    rmSync(dshHome, { recursive: true, force: true });
    rmSync(tarballPath, { force: true });
  }
});

// ---------------------------------------------------------------------------
// Issue #8: final preview and authorized submission behind a fake GitHub
// ---------------------------------------------------------------------------

/** Start a local fake GitHub GraphQL server that records every request and answers per scenario. */
async function startFakeGitHub({ swallowMutation = false } = {}) {
  const { createServer } = await import('node:http');
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body, headers: req.headers });
      const match = /(query|mutation)\s+(\w+)/.exec(body);
      const operation = match === null ? 'unknown' : match[2];
      if (operation === 'PrepareSubmission') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          data: {
            repository: {
              id: 'R_kgDOfficialRepo',
              discussionCategories: {
                nodes: [
                  { id: 'DIC_ideas', name: 'Ideas' },
                  { id: 'DIC_qna', name: 'Q&A' },
                ],
              },
            },
          },
        }));
        return;
      }
      if (operation === 'CreateDiscussion') {
        if (swallowMutation) return; // record but never respond -> unknown
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          data: { createDiscussion: { discussion: { url: 'https://github.com/deepseek-ai/deepseek-harness/discussions/7777' } } },
        }));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = 'http://127.0.0.1:' + (address === null || typeof address === 'string' ? '0' : address.port);
  return { server, requests, base };
}

/** The profile patch layer pointing the plugin's GitHub service at the fake server and fake account. */
function githubPatch(base) {
  return [
    '- id: dsh-feedback-bridge',
    '  config:',
    '    github:',
    '      graphqlEndpoint: ' + base + '/graphql',
    '      timeoutMs: 2000',
    '      auth:',
    '        provider: fake',
    '        identity:',
    '          login: fake-user',
    '',
  ].join('\n');
}

/** Count recorded mutation requests (the only write the plugin may issue). */
function githubMutationCount(requests) {
  return requests.filter((request) => /mutation\s+CreateDiscussion/.test(request.body)).length;
}

/** Fill the five public draft fields and wait for the debounced autosave. */
async function fillPublicDraft(page) {
  await page.fill('[data-testid="dsh-feedback-title"]', 'Final preview test');
  await page.fill('[data-testid="dsh-feedback-scenario"]', 'I want to export a plugin draft.');
  await page.fill('[data-testid="dsh-feedback-gap"]', 'There is no public export flow.');
  await page.fill('[data-testid="dsh-feedback-desired"]', 'A documented export plugin flow.');
  await page.fill('[data-testid="dsh-feedback-context"]', 'User stories and sample code.');
  await page.waitForTimeout(1200);
}

test('fake-backed authorized submission: final preview shows exact fields, confirm creates exactly one Discussion mutation, and the permanent URL is returned without touching issues', { skip: !hasDsh || !hasPnpm || !hasPlaywrightCore }, async () => {
  const { chromium } = await import('playwright-core');
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tarball = packFilename(repoRoot);
  const tarballPath = join(repoRoot, tarball);
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-feedback-bridge-submission-ok-'));

  const github = await startFakeGitHub();
  try {
    run('dsh', ['plugin', '--profile', 'web', 'add', tarballPath], {
      cwd: repoRoot,
      env: { ...process.env, DSH_HOME: dshHome },
    });
    writeFileSync(join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), githubPatch(github.base));
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
      await page.click('[data-testid="dsh-feedback-trigger"]');
      await page.waitForSelector('[data-testid="dsh-feedback-workspace"]', { timeout: 30_000 });
      await fillPublicDraft(page);

      // Opening the final confirmation performs no GitHub mutation.
      assert.equal(githubMutationCount(github.requests), 0, 'no mutation before opening the confirmation');
      await page.click('[data-testid="dsh-feedback-submission-open"]');
      await page.waitForSelector('[data-testid="dsh-feedback-submission-ready"]', { timeout: 20_000 });

      // The final preview shows the exact title, Markdown body, category,
      // language, official destination, and submission account.
      assert.equal((await page.textContent('[data-testid="dsh-feedback-submission-title"]')).trim(), 'Final preview test');
      assert.match(await page.textContent('[data-testid="dsh-feedback-submission-body"]'), /# Final preview test/);
      assert.equal(await page.inputValue('[data-testid="dsh-feedback-submission-category"]'), 'DIC_ideas');
      assert.match(await page.textContent('[data-testid="dsh-feedback-submission-language"]'), /English/);
      assert.match(await page.textContent('[data-testid="dsh-feedback-submission-destination"]'), /deepseek-ai\/deepseek-harness/);
      assert.equal((await page.textContent('[data-testid="dsh-feedback-submission-account"]')).trim(), 'fake-user');
      assert.equal(githubMutationCount(github.requests), 0, 'viewing the confirmation must not mutate');

      // The distinct confirm action creates exactly one Discussion.
      await page.click('[data-testid="dsh-feedback-submission-confirm"]');
      await page.waitForSelector('[data-testid="dsh-feedback-submission-created"]', { timeout: 20_000 });
      const link = await page.getAttribute('[data-testid="dsh-feedback-submission-created-link"]', 'href');
      assert.equal(link, 'https://github.com/deepseek-ai/deepseek-harness/discussions/7777');
      assert.equal(githubMutationCount(github.requests), 1, 'exactly one mutation per confirmation');

      // The mutation targeted only the official Discussions, never Issues.
      assert.ok(github.requests.length >= 2, 'the fake GitHub server must have been reached');
      assert.ok(github.requests.every((request) => !/issues/i.test(request.body) && !/issues/i.test(request.url)));

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
    github.server.close();
    rmSync(dshHome, { recursive: true, force: true });
    rmSync(tarballPath, { force: true });
  }
});




/** Start a local fake GitHub OAuth server: an approve/deny authorize page, a token endpoint, and the user endpoint. */
async function startFakeOAuth() {
  const { createServer } = await import('node:http');
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, body });
      if (req.url?.startsWith('/access_token')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          access_token: 'gho_acceptance-oauth-secret',
          refresh_token: 'ghr_acceptance-oauth-secret',
          expires_in: 3600,
          scope: 'repo',
        }));
        return;
      }
      if (req.url?.startsWith('/user')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ login: 'alice' }));
        return;
      }
      if (req.url?.startsWith('/authorize')) {
        const url = new URL(req.url, 'http://127.0.0.1');
        const state = url.searchParams.get('state');
        const redirect = url.searchParams.get('redirect_uri');
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end([
          '<!doctype html><html><body>',
          '<a id="approve" href="' + redirect + '?code=acceptance-oauth-code&state=' + state + '">Approve</a>',
          '<a id="deny" href="' + redirect + '?error=access_denied&state=' + state + '">Deny</a>',
          '</body></html>',
        ].join(''));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = 'http://127.0.0.1:' + (address === null || typeof address === 'string' ? '0' : address.port);
  return { server, requests, base };
}

/** The profile patch layer pointing the plugin at the fake OAuth and GitHub services with the oauth provider. */
function githubOauthPatch(oauthBase, githubBase) {
  return [
    '- id: dsh-feedback-bridge',
    '  config:',
    '    github:',
    '      graphqlEndpoint: ' + githubBase + '/graphql',
    '      timeoutMs: 2000',
    '      auth:',
    '        provider: oauth',
    '      oauth:',
    '        clientId: acceptance-client',
    '        authorizeEndpoint: ' + oauthBase + '/authorize',
    '        tokenEndpoint: ' + oauthBase + '/access_token',
    '        userEndpoint: ' + oauthBase + '/user',
    '',
  ].join('\n');
}

test('oauth-backed submission: the GUI signs in through a browser handoff, shows the public identity at final confirmation, and the token never reaches the Client', { skip: !hasDsh || !hasPnpm || !hasPlaywrightCore }, async () => {
  const { chromium } = await import('playwright-core');
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tarball = packFilename(repoRoot);
  const tarballPath = join(repoRoot, tarball);
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-feedback-bridge-oauth-ok-'));

  const github = await startFakeGitHub();
  const oauth = await startFakeOAuth();
  try {
    run('dsh', ['plugin', '--profile', 'web', 'add', tarballPath], {
      cwd: repoRoot,
      env: { ...process.env, DSH_HOME: dshHome },
    });
    writeFileSync(join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), githubOauthPatch(oauth.base, github.base));
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
      await page.click('[data-testid="dsh-feedback-trigger"]');
      await page.waitForSelector('[data-testid="dsh-feedback-workspace"]', { timeout: 30_000 });
      await fillPublicDraft(page);

      // Opening the confirmation offers the sign-in step with the disclosure.
      assert.equal(githubMutationCount(github.requests), 0, 'no mutation before authorization');
      await page.click('[data-testid="dsh-feedback-submission-open"]');
      await page.waitForSelector('[data-testid="dsh-feedback-submission-authorize"]', { timeout: 20_000 });
      assert.match(await page.textContent('[data-testid="dsh-feedback-submission-oauth-disclosure"]'), /credentials provider|凭据/);

      // Sign in: the browser hands off to the fake authorize page.
      const popupPromise = page.waitForEvent('popup');
      await page.click('[data-testid="dsh-feedback-submission-oauth-sign-in"]');
      await page.waitForSelector('[data-testid="dsh-feedback-submission-oauth-authorizing"]', { timeout: 20_000 });
      const popup = await popupPromise;
      await popup.waitForSelector('#approve', { timeout: 20_000 });
      await popup.click('#approve');

      // The main page polls to authorized and shows the public identity.
      await page.waitForSelector('[data-testid="dsh-feedback-submission-ready"]', { timeout: 30_000 });
      assert.equal((await page.textContent('[data-testid="dsh-feedback-submission-account"]')).trim(), 'alice');
      assert.equal(githubMutationCount(github.requests), 0, 'authorizing must not mutate');

      // The distinct confirm action creates exactly one Discussion as the authorized account.
      await page.click('[data-testid="dsh-feedback-submission-confirm"]');
      await page.waitForSelector('[data-testid="dsh-feedback-submission-created"]', { timeout: 20_000 });
      assert.equal(githubMutationCount(github.requests), 1, 'exactly one mutation per confirmation');
      const mutation = github.requests.find((request) => /mutation\s+CreateDiscussion/.test(request.body));
      assert.ok(mutation);
      assert.equal(mutation.headers.authorization, 'Bearer gho_acceptance-oauth-secret', 'the mutation runs as the stored grant');

      // No token, code, or verifier ever reaches the Client.
      const pageContent = await page.content();
      assert.ok(!pageContent.includes('gho_acceptance-oauth-secret'), 'the token must never reach the Client DOM');
      assert.ok(!pageContent.includes('acceptance-oauth-code'), 'the authorization code must never reach the Client DOM');
      assert.ok(!requests.some((url) => url.includes('gho_acceptance-oauth') || url.includes('acceptance-oauth-code')));

      await browser.close();
    } finally {
      await stopWeb(child);
    }
  } finally {
    github.server.close();
    oauth.server.close();
    rmSync(dshHome, { recursive: true, force: true });
    rmSync(tarballPath, { force: true });
  }
});

test('oauth-backed submission: denial settles as a distinct failure with zero mutation, and disconnect returns to draft export', { skip: !hasDsh || !hasPnpm || !hasPlaywrightCore }, async () => {
  const { chromium } = await import('playwright-core');
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tarball = packFilename(repoRoot);
  const tarballPath = join(repoRoot, tarball);
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-feedback-bridge-oauth-deny-'));

  const github = await startFakeGitHub();
  const oauth = await startFakeOAuth();
  try {
    run('dsh', ['plugin', '--profile', 'web', 'add', tarballPath], {
      cwd: repoRoot,
      env: { ...process.env, DSH_HOME: dshHome },
    });
    writeFileSync(join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), githubOauthPatch(oauth.base, github.base));
    const cleanEnv = { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_MODE: 'DISABLED' };
    delete cleanEnv.DSH_VERSION;
    const { child, port } = await bootWeb(cleanEnv);
    const baseUrl = 'http://127.0.0.1:' + port;

    try {
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ acceptDownloads: true });
      const page = await context.newPage();

      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunModals(page);
      await page.waitForSelector('[data-testid="dsh-feedback-trigger"]', { timeout: 60_000 });
      await page.click('[data-testid="dsh-feedback-trigger"]');
      await page.waitForSelector('[data-testid="dsh-feedback-workspace"]', { timeout: 30_000 });
      await fillPublicDraft(page);

      await page.click('[data-testid="dsh-feedback-submission-open"]');
      await page.waitForSelector('[data-testid="dsh-feedback-submission-authorize"]', { timeout: 20_000 });

      // Deny in the browser handoff: distinct failure, zero mutation.
      const denyPopupPromise = page.waitForEvent('popup');
      await page.click('[data-testid="dsh-feedback-submission-oauth-sign-in"]');
      const denyPopup = await denyPopupPromise;
      await denyPopup.waitForSelector('#deny', { timeout: 20_000 });
      await denyPopup.click('#deny');
      await page.waitForSelector('[data-testid="dsh-feedback-submission-oauth-failed"]', { timeout: 30_000 });
      assert.match(await page.textContent('[data-testid="dsh-feedback-submission-oauth-failed"]'), /declined|拒绝/);
      assert.equal(githubMutationCount(github.requests), 0, 'a denial must never mutate');

      // Retry, approve, then disconnect: the grant is revoked and export remains.
      await page.click('[data-testid="dsh-feedback-submission-oauth-retry"]');
      await page.waitForSelector('[data-testid="dsh-feedback-submission-authorize"]', { timeout: 20_000 });
      const okPopupPromise = page.waitForEvent('popup');
      await page.click('[data-testid="dsh-feedback-submission-oauth-sign-in"]');
      const okPopup = await okPopupPromise;
      await okPopup.waitForSelector('#approve', { timeout: 20_000 });
      await okPopup.click('#approve');
      await page.waitForSelector('[data-testid="dsh-feedback-submission-ready"]', { timeout: 30_000 });

      await page.click('[data-testid="dsh-feedback-submission-oauth-disconnect"]');
      await page.waitForSelector('[data-testid="dsh-feedback-submission-open"]', { timeout: 20_000 });
      assert.equal(await page.locator('[data-testid="dsh-feedback-submission-export"]').count(), 1, 'draft export must remain after disconnect');
      assert.equal(githubMutationCount(github.requests), 0, 'disconnect must never mutate');

      await browser.close();
    } finally {
      await stopWeb(child);
    }
  } finally {
    github.server.close();
    oauth.server.close();
    rmSync(dshHome, { recursive: true, force: true });
    rmSync(tarballPath, { force: true });
  }
});


/** Pairwise overlap of two viewport rects; null rects never overlap. */
function rectsOverlap(a, b) {
  if (a === null || b === null) return false;
  return !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
}

test('final confirmation expands below the edit form without overlapping any control (browser geometry regression)', { skip: !hasDsh || !hasPnpm || !hasPlaywrightCore }, async () => {
  const { chromium } = await import('playwright-core');
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tarball = packFilename(repoRoot);
  const tarballPath = join(repoRoot, tarball);
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-feedback-bridge-geometry-'));

  const github = await startFakeGitHub();
  const oauth = await startFakeOAuth();
  try {
    run('dsh', ['plugin', '--profile', 'web', 'add', tarballPath], {
      cwd: repoRoot,
      env: { ...process.env, DSH_HOME: dshHome },
    });
    writeFileSync(join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), githubOauthPatch(oauth.base, github.base));
    const cleanEnv = { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_MODE: 'DISABLED' };
    delete cleanEnv.DSH_VERSION;
    const { child, port } = await bootWeb(cleanEnv);
    const baseUrl = 'http://127.0.0.1:' + port;

    try {
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunModals(page);
      await page.waitForSelector('[data-testid="dsh-feedback-trigger"]', { timeout: 60_000 });
      await page.click('[data-testid="dsh-feedback-trigger"]');
      await page.waitForSelector('[data-testid="dsh-feedback-workspace"]', { timeout: 30_000 });
      await fillPublicDraft(page);
      await page.click('[data-testid="dsh-feedback-submission-open"]');
      await page.waitForSelector('[data-testid="dsh-feedback-submission-authorize"]', { timeout: 20_000 });
      await page.waitForTimeout(500);

      const measure = () => page.evaluate(() => {
        const rect = (selector) => {
          const el = document.querySelector(selector);
          if (el === null) return null;
          const box = el.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height };
        };
        return {
          title: rect('[data-testid="dsh-feedback-title"]'),
          scenario: rect('[data-testid="dsh-feedback-scenario"]'),
          gap: rect('[data-testid="dsh-feedback-gap"]'),
          desired: rect('[data-testid="dsh-feedback-desired"]'),
          submission: rect('[data-testid="dsh-feedback-submission"]'),
          signIn: rect('[data-testid="dsh-feedback-submission-oauth-sign-in"]'),
          disclosure: rect('[data-testid="dsh-feedback-submission-oauth-disclosure"]'),
          back: rect('[data-testid="dsh-feedback-submission-back"]'),
          exportBtn: rect('[data-testid="dsh-feedback-submission-export"]'),
        };
      });

      const assertNoOverlap = (label, boxes) => {
        // The final confirmation sits below the whole edit form, not over it.
        assert.ok(
          boxes.submission.y >= boxes.title.y + boxes.title.height,
          label + ': the final confirmation must start below the title field',
        );
        assert.ok(!rectsOverlap(boxes.submission, boxes.title), label + ': submission must not overlap the title field');
        assert.ok(!rectsOverlap(boxes.submission, boxes.scenario), label + ': submission must not overlap the scenario field');
        assert.ok(!rectsOverlap(boxes.signIn, boxes.scenario), label + ': the sign-in button must not overlap the scenario field');
        assert.ok(!rectsOverlap(boxes.disclosure, boxes.gap), label + ': the disclosure must not overlap the gap field');
        assert.ok(!rectsOverlap(boxes.back, boxes.scenario), label + ': the back button must not sit inside the scenario textarea');
        assert.ok(!rectsOverlap(boxes.exportBtn, boxes.gap), label + ': the export button must not sit inside the gap textarea');
        // The form fields keep their vertical order.
        assert.ok(
          boxes.title.y < boxes.scenario.y && boxes.scenario.y < boxes.gap.y && boxes.gap.y < boxes.desired.y,
          label + ': the edit fields must keep their vertical order',
        );
      };

      const wide = await measure();
      assertNoOverlap('wide', wide);

      // Narrower window: single-column layout must still never overlap.
      await page.setViewportSize({ width: 700, height: 800 });
      await page.waitForTimeout(400);
      const narrow = await measure();
      assertNoOverlap('narrow', narrow);

      await browser.close();
    } finally {
      await stopWeb(child);
    }
  } finally {
    github.server.close();
    oauth.server.close();
    rmSync(dshHome, { recursive: true, force: true });
    rmSync(tarballPath, { force: true });
  }
});
/** Test-only fake `gh` shim served from a temp PATH directory: two stored github.com accounts with canned tokens. */
const GH_SHIM = [
  '#!/usr/bin/env bash',
  'set -e',
  'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then',
  '  cat <<\'EOF\'',
  'github.com',
  '  ✓ Logged in to github.com account alice (/fake/hosts.yml)',
  '  - Active account: true',
  '  - Token: gho_acceptance-secret-alice',
  "  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'",
  '  ✓ Logged in to github.com account bob (/fake/hosts.yml)',
  '  - Token: gho_acceptance-secret-bob',
  'EOF',
  '  exit 0',
  'fi',
  'if [ "$1" = "auth" ] && [ "$2" = "token" ]; then',
  '  case "$4" in',
  '    alice) echo "gho_acceptance-secret-alice" ;;',
  '    bob) echo "gho_acceptance-secret-bob" ;;',
  '    *) echo "unknown account: $4" >&2; exit 1 ;;',
  '  esac',
  '  exit 0',
  'fi',
  'echo "unexpected gh command: $*" >&2',
  'exit 1',
  '',
].join('\n');

/** The profile patch layer pointing the plugin's GitHub service at the fake server with the gh provider. */
function githubGhPatch(base) {
  return [
    '- id: dsh-feedback-bridge',
    '  config:',
    '    github:',
    '      graphqlEndpoint: ' + base + '/graphql',
    '      timeoutMs: 2000',
    '      auth:',
    '        provider: gh',
    '',
  ].join('\n');
}

test('gh-backed submission: several GitHub CLI accounts force explicit selection, the chosen public account is shown at final confirmation, and the token never reaches the Client', { skip: !hasDsh || !hasPnpm || !hasPlaywrightCore }, async () => {
  const { chromium } = await import('playwright-core');
  const { mkdtempSync, rmSync, writeFileSync, chmodSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tarball = packFilename(repoRoot);
  const tarballPath = join(repoRoot, tarball);
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-feedback-bridge-submission-gh-'));
  const shimDir = mkdtempSync(join(tmpdir(), 'dsh-feedback-bridge-gh-shim-'));

  const github = await startFakeGitHub();
  try {
    run('dsh', ['plugin', '--profile', 'web', 'add', tarballPath], {
      cwd: repoRoot,
      env: { ...process.env, DSH_HOME: dshHome },
    });
    writeFileSync(join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), githubGhPatch(github.base));
    const shimPath = join(shimDir, 'gh');
    writeFileSync(shimPath, GH_SHIM);
    chmodSync(shimPath, 0o755);
    const cleanEnv = {
      ...process.env,
      DSH_HOME: dshHome,
      DSH_TELEMETRY_MODE: 'DISABLED',
      PATH: shimDir + (process.env.PATH ? ':' + process.env.PATH : ''),
    };
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
      await page.click('[data-testid="dsh-feedback-trigger"]');
      await page.waitForSelector('[data-testid="dsh-feedback-workspace"]', { timeout: 30_000 });
      await fillPublicDraft(page);

      // No GitHub mutation may occur before the final confirmation.
      assert.equal(githubMutationCount(github.requests), 0, 'no mutation before opening the confirmation');
      await page.click('[data-testid="dsh-feedback-submission-open"]');
      await page.waitForSelector('[data-testid="dsh-feedback-submission-account-select"]', { timeout: 20_000 });

      // Two stored accounts force an explicit selection.
      assert.equal(await page.locator('[data-testid^="dsh-feedback-submission-account-option-"]').count(), 2);
      await page.check('[data-testid="dsh-feedback-submission-account-option-alice"]');
      await page.click('[data-testid="dsh-feedback-submission-account-continue"]');
      await page.waitForSelector('[data-testid="dsh-feedback-submission-ready"]', { timeout: 20_000 });

      // The chosen public account is shown again on the final confirmation.
      assert.equal((await page.textContent('[data-testid="dsh-feedback-submission-account"]')).trim(), 'alice');
      assert.equal(githubMutationCount(github.requests), 0, 'selecting an account must not mutate');

      // The distinct confirm action creates exactly one Discussion as the selected account.
      await page.click('[data-testid="dsh-feedback-submission-confirm"]');
      await page.waitForSelector('[data-testid="dsh-feedback-submission-created"]', { timeout: 20_000 });
      assert.equal(githubMutationCount(github.requests), 1, 'exactly one mutation per confirmation');
      const mutation = github.requests.find((request) => /mutation\s+CreateDiscussion/.test(request.body));
      assert.ok(mutation, 'the fake GitHub server must have received the mutation');
      assert.equal(mutation.headers.authorization, 'Bearer gho_acceptance-secret-alice', 'the mutation runs as the selected account');
      assert.ok(!/issues/i.test(mutation.url), 'the mutation targets only the official Discussions');

      // The token never reaches the Client: not in page content and not in any browser request.
      const pageContent = await page.content();
      assert.ok(!pageContent.includes('gho_acceptance-secret-alice'), 'the token must never reach the Client DOM');
      assert.ok(!pageContent.includes('gho_acceptance-secret-bob'), 'no account token may reach the Client DOM');
      assert.ok(!requests.some((url) => url.includes('gho_acceptance')), 'the token must never appear in Client requests');

      await browser.close();
    } finally {
      await stopWeb(child);
    }
  } finally {
    github.server.close();
    rmSync(dshHome, { recursive: true, force: true });
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(tarballPath, { force: true });
  }
});

test('fake-backed submission: an unknown result performs exactly one mutation, never retries, and keeps the draft exportable', { skip: !hasDsh || !hasPnpm || !hasPlaywrightCore }, async () => {
  const { chromium } = await import('playwright-core');
  const { mkdtempSync, rmSync, readFileSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tarball = packFilename(repoRoot);
  const tarballPath = join(repoRoot, tarball);
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-feedback-bridge-submission-unknown-'));

  const github = await startFakeGitHub({ swallowMutation: true });
  try {
    run('dsh', ['plugin', '--profile', 'web', 'add', tarballPath], {
      cwd: repoRoot,
      env: { ...process.env, DSH_HOME: dshHome },
    });
    writeFileSync(join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), githubPatch(github.base));
    const cleanEnv = { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_MODE: 'DISABLED' };
    delete cleanEnv.DSH_VERSION;
    const { child, port } = await bootWeb(cleanEnv);
    const baseUrl = 'http://127.0.0.1:' + port;

    try {
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ acceptDownloads: true });
      const page = await context.newPage();

      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await dismissFirstRunModals(page);
      await page.waitForSelector('[data-testid="dsh-feedback-trigger"]', { timeout: 60_000 });
      await page.click('[data-testid="dsh-feedback-trigger"]');
      await page.waitForSelector('[data-testid="dsh-feedback-workspace"]', { timeout: 30_000 });
      await fillPublicDraft(page);

      await page.click('[data-testid="dsh-feedback-submission-open"]');
      await page.waitForSelector('[data-testid="dsh-feedback-submission-ready"]', { timeout: 20_000 });
      await page.click('[data-testid="dsh-feedback-submission-confirm"]');
      await page.waitForSelector('[data-testid="dsh-feedback-submission-unknown"]', { timeout: 30_000 });

      // Manual verification guidance is shown and no retry control exists.
      assert.match(await page.textContent('[data-testid="dsh-feedback-submission-unknown-guidance"]'), /Check the official Discussions|前往官方 Discussions/);
      assert.equal(await page.locator('[data-testid="dsh-feedback-submission-confirm"]').count(), 0, 'an unknown result must never offer another submit');

      // Exactly one mutation attempt, and no automatic retry ever arrives.
      assert.equal(githubMutationCount(github.requests), 1, 'exactly one mutation attempt');
      await page.waitForTimeout(4500);
      assert.equal(githubMutationCount(github.requests), 1, 'an unknown result must never retry automatically');

      // The reviewed draft stays exportable from the unknown panel.
      const downloadPromise = page.waitForEvent('download');
      await page.click('[data-testid="dsh-feedback-submission-export"]');
      const download = await downloadPromise;
      const exported = readFileSync(await download.path(), 'utf8');
      assert.match(exported, /# Final preview test/);
      await browser.close();
    } finally {
      await stopWeb(child);
    }
  } finally {
    github.server.close();
    rmSync(dshHome, { recursive: true, force: true });
    rmSync(tarballPath, { force: true });
  }
});

