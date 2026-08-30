
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import {
  createGhCli,
  createGhRun,
  parseGhAuthStatus,
  sanitizeGhEnv,
} from '../lib/gh-cli.js';

test('parseGhAuthStatus resolves a single logged-in account and marks it active', () => {
  const accounts = parseGhAuthStatus([
    'github.com',
    '  ✓ Logged in to github.com account alice (/home/u/.config/gh/hosts.yml)',
    '  - Active account: true',
    '  - Token: gho_xxxx',
    "  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'",
  ].join('\n'));
  assert.deepEqual(accounts, [{ login: 'alice', active: true }]);
});

test('parseGhAuthStatus resolves several accounts with exactly one active and ignores other hosts', () => {
  const accounts = parseGhAuthStatus([
    'github.com',
    '  ✓ Logged in to github.com account alice (/home/u/.config/gh/hosts.yml)',
    '  - Active account: true',
    '  - Token: gho_aaaa',
    '  ✓ Logged in to github.com account bob (/home/u/.config/gh/hosts.yml)',
    '  - Token: gho_bbbb',
    'github.example.com',
    '  ✓ Logged in to github.com.example.com account corp (/home/u/.config/gh/hosts.yml)',
  ].join('\n'));
  assert.deepEqual(accounts, [
    { login: 'alice', active: true },
    { login: 'bob', active: false },
  ]);
});

test('parseGhAuthStatus returns no accounts when gh reports no stored login', () => {
  assert.deepEqual(parseGhAuthStatus('! not logged in\n'), []);
  assert.deepEqual(parseGhAuthStatus(''), []);
});

test('sanitizeGhEnv strips GitHub and model credentials but keeps benign variables', () => {
  const env = sanitizeGhEnv({
    PATH: '/usr/bin',
    HOME: '/home/u',
    GH_TOKEN: 'gho_ambient',
    GITHUB_TOKEN: 'ghp_ambient',
    GH_ENTERPRISE_TOKEN: 'ghs_ambient',
    GITHUB_ENTERPRISE_TOKEN: 'ggg_ambient',
    DEEPSEEK_API_KEY: 'sk-ambient',
  });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/u');
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GH_ENTERPRISE_TOKEN, undefined);
  assert.equal(env.GITHUB_ENTERPRISE_TOKEN, undefined);
  assert.equal(env.DEEPSEEK_API_KEY, undefined);
});

test('createGhCli listAccounts runs gh auth status and maps its output', async () => {
  const calls = [];
  const cli = createGhCli(async (args) => {
    calls.push(args);
    return {
      code: 0,
      stdout: [
        'github.com',
        '  ✓ Logged in to github.com account alice (/h.yml)',
        '  - Active account: true',
        '  ✓ Logged in to github.com account bob (/h.yml)',
      ].join('\n'),
      stderr: '',
    };
  });
  const accounts = await cli.listAccounts();
  assert.deepEqual(calls, [['auth', 'status']]);
  assert.deepEqual(accounts, [
    { login: 'alice', active: true },
    { login: 'bob', active: false },
  ]);
});

test('createGhCli listAccounts reports no accounts when gh auth status fails', async () => {
  const cli = createGhCli(async () => ({ code: 1, stdout: 'not logged in', stderr: '' }));
  assert.deepEqual(await cli.listAccounts(), []);
});

test('createGhCli tokenFor returns the trimmed token for the requested account only', async () => {
  const calls = [];
  const cli = createGhCli(async (args) => {
    calls.push(args);
    return { code: 0, stdout: 'gho_secret-alice\n', stderr: '' };
  });
  const token = await cli.tokenFor('alice');
  assert.deepEqual(calls, [['auth', 'token', '-u', 'alice']]);
  assert.equal(token, 'gho_secret-alice');
});

test('createGhCli tokenFor throws when gh cannot resolve the account token', async () => {
  const cli = createGhCli(async () => ({ code: 1, stdout: '', stderr: 'not found' }));
  await assert.rejects(() => cli.tokenFor('missing'), /no GitHub CLI token/);
});

test('createGhRun spawns gh without a shell and with a credential-free env', async () => {
  const calls = [];
  let child;
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    child = new EventEmitter();
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => { child.killed = true; };
    return child;
  };
  const run = createGhRun(spawnFn, 5000);
  const previous = { ...process.env };
  process.env.GH_TOKEN = 'gho_ambient';
  try {
    const promise = run(['auth', 'status']);
    const options = calls[0].options;
    assert.equal(calls[0].command, 'gh');
    assert.deepEqual(calls[0].args, ['auth', 'status']);
    assert.equal(options.shell, undefined, 'gh must never run through a shell');
    assert.equal(options.windowsHide, true);
    assert.equal(options.env.GH_TOKEN, undefined, 'the child env must not inherit GH_TOKEN');
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from('github.com\n  ✓ Logged in to github.com account alice (/h.yml)\n'));
      child.emit('close', 0);
    });
    const result = await promise;
    assert.equal(result.code, 0);
    assert.match(result.stdout, /account alice/);
  } finally {
    if (previous.GH_TOKEN === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous.GH_TOKEN;
  }
});

test('createGhRun kills the gh child on timeout and reports a failed run', async () => {
  let child;
  const spawnFn = (_command, _args, _options) => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    child = new EventEmitter();
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => { child.killed = true; };
    return child;
  };
  const run = createGhRun(spawnFn, 25);
  const result = await run(['auth', 'status']);
  assert.equal(result.code, -1);
  assert.equal(child.killed, true, 'the gh child must be killed on timeout');
});

test('createGhRun resolves a failed spawn without hanging', async () => {
  const spawnFn = () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter();
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => {};
    process.nextTick(() => child.emit('error', new Error('ENOENT')));
    return child;
  };
  const run = createGhRun(spawnFn, 5000);
  const result = await run(['auth', 'status']);
  assert.equal(result.code, -1);
});
