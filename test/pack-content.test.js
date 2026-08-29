import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

test('npm pack ships exactly the intended runtime files and nothing else', () => {
  const [result] = JSON.parse(
    execFileSync('npm', ['pack', '--json'], { cwd: repoRoot, encoding: 'utf8' }),
  );
  const paths = result.files.map((entry) => entry.path).sort();
  assert.deepEqual(paths, [
    'LICENSE',
    'README.md',
    'cordis.patch.yml',
    'lib/client.js',
    'lib/draft-store.js',
    'lib/index.js',
    'package.json',
  ]);
});
