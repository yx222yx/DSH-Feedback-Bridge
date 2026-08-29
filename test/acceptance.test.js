import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
