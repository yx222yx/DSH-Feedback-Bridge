import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

test('npm pack ships exactly the intended runtime files and nothing else', () => {
  // Some pnpm versions print a dependency-verification preamble before the
  // JSON payload; locate the array by its opening bracket.
  const output = execFileSync('npm', ['pack', '--json'], { cwd: repoRoot, encoding: 'utf8' });
  const [result] = JSON.parse(output.slice(output.indexOf('[')));
  const paths = result.files.map((entry) => entry.path).sort();
  assert.deepEqual(paths, [
    'LICENSE',
    'README.md',
    'cordis.patch.yml',
    'lib/assist-event.js',
    'lib/assist-schema.js',
    'lib/assist.js',
    'lib/client.js',
    'lib/draft-store.js',
    'lib/feedback-types.js',
    'lib/github.js',
    'lib/index.js',
    'lib/similarity.js',
    'lib/submission.js',
    'lib/type-needs.js',
    'package.json',
  ]);
});