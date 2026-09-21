import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '@gca/shared';

const TOKEN_TTL_MS = 5 * 60 * 1000;

interface Issued {
  action: string;
  entityId: string;
  /** Hash of the exact changes shown to the user when the token was issued. */
  proposalHash: string;
  expiresAt: number;
}

/**
 * Two-step confirmation for destructive operations.
 *
 * The token binds to the *specific* proposal the user was shown, not just to the
 * action. If the plan changes between the preview and the confirmation — more files
 * would be deleted, say — the old token no longer matches and the call is refused.
 */
export class ConfirmationService {
  readonly #secret = randomBytes(32);
  readonly #issued = new Map<string, Issued>();

  issue(action: string, entityId: string, proposal: unknown): string {
    this.prune();
    const nonce = randomBytes(16).toString('base64url');
    const proposalHash = this.hash(JSON.stringify(proposal ?? {}));
    this.#issued.set(nonce, {
      action,
      entityId,
      proposalHash,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });
    return nonce;
  }

  consume(token: string | undefined, action: string, entityId: string, proposal: unknown): void {
    this.prune();
    if (!token) {
      throw new AppError(
        'CONFIRMATION_REQUIRED',
        'This action changes data on your device. Fetch the proposed changes first, then confirm them.',
      );
    }
    const issued = this.#issued.get(token);
    if (!issued || issued.action !== action || issued.entityId !== entityId) {
      throw new AppError(
        'CONFIRMATION_REQUIRED',
        'This confirmation token is not valid for this action.',
      );
    }
    if (issued.expiresAt < Date.now()) {
      this.#issued.delete(token);
      throw new AppError(
        'CONFIRMATION_REQUIRED',
        'This confirmation expired. Review the changes again.',
      );
    }

    const expected = Buffer.from(issued.proposalHash, 'hex');
    const actual = Buffer.from(this.hash(JSON.stringify(proposal ?? {})), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      this.#issued.delete(token);
      throw new AppError(
        'CONFIRMATION_REQUIRED',
        'The proposed changes have changed since you reviewed them. Review and confirm again.',
      );
    }

    // Single use.
    this.#issued.delete(token);
  }

  private hash(value: string): string {
    return createHmac('sha256', this.#secret).update(value).digest('hex');
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, issued] of this.#issued) {
      if (issued.expiresAt < now) this.#issued.delete(token);
    }
  }
}
