import type { DeviceProfileId, ProbeTranscriptEntry } from '@gca/shared';
import { capabilitiesFor, isWritableProfile } from './capabilities.js';
import type { DeviceTransport } from './http.js';

export interface DetectionResult {
  profileId: DeviceProfileId;
  modelName: string | null;
  firmwareVersion: string | null;
  supported: boolean;
  reachable: boolean;
  transcript: ProbeTranscriptEntry[];
  warnings: string[];
}

const STEP_TIMEOUT_MS = 5_000;
/** Detection must not hang the UI even if every step times out individually. */
const OVERALL_TIMEOUT_MS = 20_000;

/**
 * Read-only firmware detection.
 *
 * Runs strictly in the documented order and stops at the first confident match.
 * Nothing here writes to the device: an unrecognised unit must never receive a write,
 * so classification has to happen before any adapter is selected.
 */
export async function detectProfile(
  transport: DeviceTransport,
  options: { signal?: AbortSignal } = {},
): Promise<DetectionResult> {
  const transcript: ProbeTranscriptEntry[] = [];
  const warnings: string[] = [];
  const deadline = Date.now() + OVERALL_TIMEOUT_MS;
  let reachable = false;
  let modelName: string | null = null;
  let firmwareVersion: string | null = null;

  const step = async (
    name: string,
    path: string,
    classify: (
      body: string,
      status: number,
    ) => { profile?: DeviceProfileId; detail: string; matched: boolean },
  ): Promise<DeviceProfileId | null> => {
    if (Date.now() > deadline) {
      transcript.push({
        step: name,
        path,
        status: null,
        outcome: 'skipped',
        detail: 'Overall probe timeout reached',
        durationMs: 0,
      });
      return null;
    }
    const startedAt = Date.now();
    try {
      const response = await transport.get(path, {
        timeoutMs: Math.min(STEP_TIMEOUT_MS, Math.max(500, deadline - Date.now())),
        maxBytes: 64 * 1024,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      reachable = true;
      const verdict = classify(response.text, response.status);
      transcript.push({
        step: name,
        path,
        status: response.status,
        outcome: verdict.matched ? 'match' : 'no-match',
        detail: verdict.detail,
        durationMs: Date.now() - startedAt,
      });
      return verdict.matched ? (verdict.profile ?? null) : null;
    } catch (error) {
      transcript.push({
        step: name,
        path,
        status: null,
        outcome: 'error',
        detail: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      });
      return null;
    }
  };

  // 1. /v.json carries the model string, which is the most direct signal.
  const versionProfile = await step('version-json', '/v.json', (body) => {
    const parsed = parseJson(body);
    if (!parsed || typeof parsed !== 'object') return { detail: 'Not JSON', matched: false };
    const record = parsed as Record<string, unknown>;
    const model = typeof record['m'] === 'string' ? record['m'] : null;
    const version = typeof record['v'] === 'string' ? record['v'] : null;
    if (model) modelName = model;
    if (version) firmwareVersion = version;
    if (!model) return { detail: 'JSON without model field', matched: false };
    const lower = model.toLowerCase();
    if (lower.includes('pro'))
      return { profile: 'stock-pro', detail: `model="${model}"`, matched: true };
    if (lower.includes('ultra'))
      return { profile: 'stock-ultra', detail: `model="${model}"`, matched: true };
    return { detail: `Unrecognised model "${model}"`, matched: false };
  });
  if (versionProfile) return finish(versionProfile);

  // 2-3. The presence of the app manifest distinguishes PRO from Ultra.
  const proProfile = await step('sys-app-json', '/.sys/app.json', (body) => {
    const parsed = parseJson(body);
    return parsed && typeof parsed === 'object'
      ? { profile: 'stock-pro' as const, detail: 'Valid /.sys/app.json', matched: true }
      : { detail: 'Not JSON', matched: false };
  });
  if (proProfile) return finish(proProfile);

  const ultraProfile = await step('app-json', '/app.json', (body) => {
    const parsed = parseJson(body);
    return parsed && typeof parsed === 'object'
      ? { profile: 'stock-ultra' as const, detail: 'Valid /app.json', matched: true }
      : { detail: 'Not JSON', matched: false };
  });
  if (ultraProfile) return finish(ultraProfile);

  // 4. SD_PRO-style firmware exposes a theme list instead.
  const sdProfile = await step('theme-list', '/theme/list', (body) => {
    const parsed = parseJson(body);
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as Record<string, unknown>)['themes'])
    ) {
      return { profile: 'sd-pro' as const, detail: 'themes[] present', matched: true };
    }
    return { detail: 'No themes array', matched: false };
  });
  if (sdProfile) return finish(sdProfile);

  // 5. Legacy weather-clock fingerprint: recognised for diagnostics, never written to.
  const legacyProfile = await step('legacy-root', '/', (body) => {
    const hasGifList = body.includes('id="giflist"');
    const hasConnect = body.includes("action='/connect'") || body.includes('action="/connect"');
    return hasGifList && hasConnect
      ? {
          profile: 'weather-clock-legacy' as const,
          detail: 'giflist + /connect form',
          matched: true,
        }
      : { detail: 'No legacy fingerprint', matched: false };
  });
  if (legacyProfile) {
    warnings.push(
      'This looks like a legacy weather-clock firmware. It is detected for diagnostics only and will not be written to.',
    );
    return finish(legacyProfile);
  }

  if (!reachable) {
    warnings.push(
      'No endpoint responded. Check the address and that the device is on this network.',
    );
  } else {
    warnings.push(
      'The device responded but did not match a known firmware profile. Export a probe report from Diagnostics to help add support.',
    );
  }
  return finish('unknown');

  function finish(profileId: DeviceProfileId): DetectionResult {
    return {
      profileId,
      modelName,
      firmwareVersion,
      supported: isWritableProfile(profileId),
      reachable,
      transcript,
      warnings,
    };
  }
}

function parseJson(body: string): unknown {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export { capabilitiesFor };
