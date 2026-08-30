import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

test('the shipped bundle patch enables both GitHub authorization paths with the official client ID', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.match(patch, /id: dsh-feedback-bridge/);
  assert.match(patch, /auth:\s*\n\s*provider: both/);
  assert.match(patch, /oauth:\s*\n\s*clientId: Ov23liqCYa6Ll4B61lST/);
});

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
    'lib/gh-cli.js',
    'lib/github.js',
    'lib/index.js',
    'lib/oauth.js',
    'lib/records.js',
    'lib/similarity.js',
    'lib/submission.js',
    'lib/type-needs.js',
    'package.json',
  ]);
});