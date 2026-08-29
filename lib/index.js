import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const name = 'dsh-feedback-bridge';
const inject = ['webServer'];
export { name, inject };

const STATUS_PATH = '/dsh-feedback-bridge/status';

/**
 * Read this package's own manifest once. `import.meta.url` lives inside
 * `lib/index.js`, so the package root is one directory up.
 */
const manifestUrl = new URL('../package.json', import.meta.url);
const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
const compatibilityRange = manifest.dsh?.compatibility?.dsh ?? '>=0.1.1-rc.2 <0.2.0';

/** Parse a semver-shaped version into comparable parts. */
function parseVersion(raw) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(raw).trim());
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/** Compare two parsed versions; returns negative, zero, or positive. */
function compareParsed(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    const delta = a[key] - b[key];
    if (delta !== 0) return delta;
  }
  if (a.prerelease === null && b.prerelease === null) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

function comparePrerelease(a, b) {
  const left = a.split('.');
  const right = b.split('.');
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const l = left[index];
    const r = right[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const lNumber = /^\d+$/.test(l);
    const rNumber = /^\d+$/.test(r);
    if (lNumber && rNumber) {
      const delta = Number(l) - Number(r);
      if (delta !== 0) return delta;
    } else if (lNumber) {
      return -1;
    } else if (rNumber) {
      return 1;
    } else if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Parse the supported `>=min <max` range from package.json's
 * `dsh.compatibility.dsh` field.
 */
function parseRange(range) {
  const parts = range.trim().split(/\s+/).filter(Boolean);
  let min = null;
  let max = null;
  for (const part of parts) {
    if (part.startsWith('>=')) min = part.slice(2);
    else if (part.startsWith('<')) max = part.slice(1);
  }
  return { min, max };
}

/** Return true when `version` satisfies the declared DSH range. */
export function isDshVersionCompatible(version, range = compatibilityRange) {
  const parsed = parseVersion(version);
  const bounds = parseRange(range);
  if (parsed === null) return false;
  if (bounds.min !== null) {
    const min = parseVersion(bounds.min);
    if (min !== null && compareParsed(parsed, min) < 0) return false;
  }
  if (bounds.max !== null) {
    const max = parseVersion(bounds.max);
    if (max !== null && compareParsed(parsed, max) >= 0) return false;
  }
  return true;
}

/**
 * Resolve the running DeepSeek Harness version without importing Harness
 * internals. The env override keeps the compatibility check testable from a
 * fake-backed test; under the real CLI the bin path is the source of truth.
 */
export function detectDshVersion() {
  if (process.env.DSH_VERSION !== undefined && process.env.DSH_VERSION !== '') {
    return process.env.DSH_VERSION;
  }
  const invoked = process.argv[1];
  if (invoked === undefined) return null;
  try {
    const real = realpathSync(invoked);
    if (!/(?:^|[\\/])@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/.test(real)) return null;
    const version = JSON.parse(readFileSync(new URL('../package.json', pathToFileURL(real)), 'utf8')).version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

/** Throw when a detected DSH version is outside the declared range. */
export function assertCompatibleDsh(version = detectDshVersion()) {
  if (version === null) return;
  if (!isDshVersionCompatible(version)) {
    throw new Error(
      `dsh-feedback-bridge: incompatible DeepSeek Harness version ${version}; this bundle supports ${compatibilityRange}.`,
    );
  }
}

/** Read this package's version for the status payload. */
export function ownVersion() {
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
}

/** Build the host status payload served to the Client. */
export function statusPayload(dshVersion = detectDshVersion()) {
  return {
    name: 'DSH Feedback Bridge',
    status: 'loaded',
    version: ownVersion(),
    dshVersion,
    compatible: dshVersion === null ? null : isDshVersionCompatible(dshVersion),
  };
}

/**
 * Host plugin entry point. The top-level `inject: ['webServer']` keeps this
 * plugin pending outside the Web profile; once `webServer` exists, the
 * route below is the Host's only lifecycle resource.
 */
export function apply(ctx) {
  assertCompatibleDsh();
  ctx.effect(() => {
    return ctx.webServer.register({
      kind: 'exact',
      path: STATUS_PATH,
      handler(_request, response) {
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(JSON.stringify(statusPayload()));
      },
    });
  }, 'dsh-feedback-bridge: status route');
}
