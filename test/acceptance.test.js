import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

test('packed bundle installs into a clean DSH Web profile and serves the status route', { skip: !hasDsh || !hasPnpm }, async () => {
  const tarball = JSON.parse(run('npm', ['pack', '--json'], { cwd: repoRoot }))[0].filename;
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
  const tarball = JSON.parse(run('npm', ['pack', '--json'], { cwd: repoRoot }))[0].filename;
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

      // A clean profile shows two sequential first-run modals — "Internal
      // Testing Notice" then "Add an API key to get started" — that cover the
      // sidebar. Dismiss each one so the left-nav entry is reachable.
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

      // The left-navigation entry hydrates with the client app.
      await page.waitForSelector('[data-testid="dsh-feedback-trigger"]', { timeout: 60_000 });
      const triggerText = (await page.textContent('[data-testid="dsh-feedback-trigger"]')).trim();
      assert.equal(triggerText, '社区反馈');

      // Selecting the entry opens the feedback workspace directly.
      await page.click('[data-testid="dsh-feedback-trigger"]');
      await page.waitForSelector('[data-testid="dsh-feedback-workspace"]', { timeout: 30_000 });
      const typeText = (await page.textContent('[data-testid="dsh-feedback-type"]')).trim();
      assert.equal(typeText, 'Custom feedback');

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

      // Closing keeps the draft in memory; reopening resumes it.
      await page.click('[data-testid="dsh-feedback-close"]');
      await page.waitForSelector('[data-testid="dsh-feedback-workspace"]', { state: 'detached', timeout: 10_000 });
      await page.click('[data-testid="dsh-feedback-trigger"]');
      await page.waitForSelector('[data-testid="dsh-feedback-workspace"]', { timeout: 10_000 });
      assert.equal(await page.inputValue('[data-testid="dsh-feedback-title"]'), 'Add a plugin API to Harness');

      // Cancelling discards the draft; reopening starts a blank session.
      await page.click('[data-testid="dsh-feedback-cancel"]');
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
