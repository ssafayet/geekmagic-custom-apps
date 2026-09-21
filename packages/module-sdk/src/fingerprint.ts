import { createHash } from 'node:crypto';
import type { ModuleFrameDraft } from './frame.js';

/** Deterministic JSON with sorted keys so key order never changes a fingerprint. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/**
 * Hashes only what a viewer can see. `validUntil` and any prior fingerprint are excluded,
 * so a frame whose expiry moves but whose content is identical still suppresses an upload.
 */
export function computeFrameFingerprint(frame: ModuleFrameDraft): string {
  const { fingerprint: _f, validUntil: _v, ...visible } = frame;
  return createHash('sha256').update(stableStringify(visible)).digest('hex').slice(0, 32);
}
