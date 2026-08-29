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

/**
 * Extract the supported DSH version range from a parsed package manifest.
 *
 * @param sourceManifest - parsed package.json object.
 * @returns the non-empty compatibility range string.
 * @throws {Error} when `dsh.compatibility.dsh` is missing or empty.
 */
export function compatibilityRangeOf(sourceManifest) {
  const range = sourceManifest?.dsh?.compatibility?.dsh;
  if (typeof range !== 'string' || range.trim() === '') {
    throw new Error(
      'dsh-feedback-bridge: package.json must declare a non-empty dsh.compatibility.dsh range',
    );
  }
  return range;
}

const compatibilityRange = compatibilityRangeOf(manifest);

/**
 * Parse a semver-shaped version into comparable parts.
 *
 * @param raw - version string such as `0.1.1-rc.2`.
 * @returns parsed version parts, or null when the string is not semver-shaped.
 */
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

/**
 * Compare two parsed versions; returns negative, zero, or positive.
 *
 * @param a - left parsed version.
 * @param b - right parsed version.
 * @returns comparison delta.
 */
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

/**
 * Compare two semver prerelease labels.
 *
 * @param a - left prerelease label.
 * @param b - right prerelease label.
 * @returns comparison delta.
 */
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
 * Parse the supported `>=min <max` range shape.
 *
 * @param range - range string such as `>=0.1.1-rc.2 <0.2.0`.
 * @returns lower and upper bounds.
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

/**
 * Test whether a DSH version satisfies the supported range.
 *
 * @param version - DSH version string to test.
 * @param range - supported range; defaults to this package's declared range.
 * @returns true when the version is inside the range.
 */
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
 * internals. The env override keeps the check testable from a fake-backed
 * test; under the real CLI the bin path is the source of truth.
 *
 * @returns detected DSH version, or null when the CLI cannot be identified.
 */
export function detectDshVersion() {
  if (process.env.DSH_VERSION !== undefined && process.env.DSH_VERSION !== '') {
    return process.env.DSH_VERSION;
  }
  const invoked = process.argv[1];
  if (invoked === undefined) return null;

  let real;
  try {
    real = realpathSync(invoked);
  } catch (error) {
    // realpathSync fails when argv[1] is not a resolvable filesystem path
    // (for example in tests or a custom launcher); there is then no version
    // to detect, and assertCompatibleDsh turns that into a loud failure.
    void error;
    return null;
  }

  if (!/(?:^|[\\/])@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/.test(real)) return null;

  try {
    const manifestContent = readFileSync(new URL('../package.json', pathToFileURL(real)), 'utf8');
    const parsed = JSON.parse(manifestContent);
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch (error) {
    // readFileSync or JSON.parse fails only when the DSH CLI layout differs
    // from the expected package.json anchor or its manifest is unreadable;
    // null propagates to assertCompatibleDsh for a loud error.
    void error;
    return null;
  }
}

/**
 * Reject incompatible or undetectable DSH versions before any route is
 * registered.
 *
 * @param version - DSH version to check; defaults to detectDshVersion().
 * @returns void.
 * @throws {Error} when the version is outside the supported range or cannot
 * be detected.
 */
export function assertCompatibleDsh(version = detectDshVersion()) {
  if (version === null) {
    throw new Error(
      `dsh-feedback-bridge: unable to detect DeepSeek Harness version; this bundle supports ${compatibilityRange}.`,
    );
  }
  if (!isDshVersionCompatible(version)) {
    throw new Error(
      `dsh-feedback-bridge: incompatible DeepSeek Harness version ${version}; this bundle supports ${compatibilityRange}.`,
    );
  }
}

/**
 * Read this package's version for the status payload.
 *
 * @returns package version string.
 */
export function ownVersion() {
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
}

/**
 * Build the host status payload served to the Client.
 *
 * @param dshVersion - detected DSH version; defaults to detectDshVersion().
 * @returns status payload object.
 */
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
 *
 * @param ctx - Cordis context carrying the `webServer` service.
 * @returns void.
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
