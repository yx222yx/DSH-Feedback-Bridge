import type { FeedbackDraftFields, FeedbackFieldKey, PrivacyFinding, PrivacyFindingKind, PrivacySeverity } from './types.js';
import { sensitiveMarkerHit, utf8ByteLength } from './sources.js';
import type { ConfirmedSourceRecord } from './sources.js';

/**
 * Deterministic privacy scan over confirmed sources and the public draft
 * fields. Findings are read-only advisory rows: no code path rewrites,
 * redacts, or deletes content because of a finding.
 */

/** Private-path shapes: home directories, Windows drives, WSL mounts, root. */
const PRIVATE_PATH_PATTERNS = [
  /\/(?:home|Users)\/[^\s/]+/i,
  /^[A-Za-z]:\\/,
  /\\wsl(?:\\|\$)/,
  /\/root\//,
];

/** Total confirmed-source bytes above which context is considered excessive. */
export const EXCESS_CONTEXT_BYTES = 64 * 1024;

/** Byte cap on one finding excerpt. */
export const PRIVACY_EXCERPT_CHARS = 80;

/** The five public draft field names, in render order. */
const DRAFT_KEYS = ['title', 'scenario', 'gap', 'desired', 'context'] as const;

/** Bounded first-line excerpt of a finding. */
function excerpt(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > PRIVACY_EXCERPT_CHARS ? trimmed.slice(0, PRIVACY_EXCERPT_CHARS) + '…' : trimmed;
}

/** Whether text contains a private-path shape. */
function privatePathHit(text: string): boolean {
  return PRIVATE_PATH_PATTERNS.some((pattern) => pattern.test(text));
}

/** Push one finding, skipping duplicates of the same stable id. */
function pushFinding(findings: PrivacyFinding[], finding: PrivacyFinding): void {
  if (!findings.some((existing) => existing.id === finding.id)) findings.push(finding);
}

/**
 * Scan the public draft fields and the confirmed sources for advisory
 * privacy findings. Credential markers in a public field are critical;
 * markers in confirmed sources and private paths are warnings; excessive
 * confirmed-source context is informational. The input objects are never
 * mutated.
 *
 * @param fields - the five public draft fields.
 * @param sources - confirmed source snapshots.
 * @returns the derived findings, or an empty array when nothing matches.
 */
export function scanPrivacy(fields: FeedbackDraftFields, sources: readonly ConfirmedSourceRecord[]): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];
  for (const key of DRAFT_KEYS as readonly FeedbackFieldKey[]) {
    const value = fields[key];
    if (value === '') continue;
    const base = { location: 'draft' as const, field: key, excerpt: excerpt(value) };
    if (sensitiveMarkerHit(value)) {
      pushFinding(findings, { ...base, id: 'privacy:draft:' + key + ':secret', severity: 'critical', kind: 'secret' });
    }
    if (privatePathHit(value)) {
      pushFinding(findings, { ...base, id: 'privacy:draft:' + key + ':private-path', severity: 'warning', kind: 'private-path' });
    }
  }
  let totalBytes = 0;
  for (const source of sources) {
    totalBytes += utf8ByteLength(source.text);
    const base = { location: 'source' as const, sourceId: source.id, excerpt: excerpt(source.text) };
    if (sensitiveMarkerHit(source.text)) {
      pushFinding(findings, { ...base, id: 'privacy:source:' + source.id + ':secret', severity: 'warning', kind: 'secret' });
    }
    if (privatePathHit(source.text)) {
      pushFinding(findings, { ...base, id: 'privacy:source:' + source.id + ':private-path', severity: 'warning', kind: 'private-path' });
    }
  }
  if (totalBytes > EXCESS_CONTEXT_BYTES) {
    pushFinding(findings, {
      id: 'privacy:excess-context',
      severity: 'info',
      kind: 'excess-context',
      location: 'source',
      excerpt: String(totalBytes) + ' bytes of confirmed source content',
    });
  }
  return findings;
}

/** Re-export the kind and severity vocabularies for the UI. */
export type { PrivacyFindingKind, PrivacySeverity };
