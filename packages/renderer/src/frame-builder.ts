import { computeFrameFingerprint, type ModuleFrame, type ModuleFrameDraft } from '@gca/module-sdk';

/**
 * Completes a module's frame draft: fills the fingerprint from visible content and a
 * default expiry. Modules never compute these themselves, so the suppression rule is
 * applied uniformly.
 */
export function finalizeFrame(
  draft: ModuleFrameDraft,
  options: { now: Date; defaultTtlSeconds?: number },
): ModuleFrame {
  const ttl = options.defaultTtlSeconds ?? 300;
  return {
    ...draft,
    validUntil: draft.validUntil ?? new Date(options.now.getTime() + ttl * 1000).toISOString(),
    fingerprint: draft.fingerprint ?? computeFrameFingerprint(draft),
  };
}

export function frameIsValid(frame: ModuleFrame, now: Date): boolean {
  return Date.parse(frame.validUntil) > now.getTime();
}
