import type { ReactNode } from 'react';
import { Button } from '../../components/ui.js';

export const SETUP_STEPS = [
  { slug: 'welcome', title: 'Welcome' },
  { slug: 'preferences', title: 'Preferences' },
  { slug: 'display', title: 'Add a display' },
  { slug: 'check', title: 'Check the display' },
  { slug: 'modules', title: 'Choose modules' },
  { slug: 'order', title: 'Display order' },
  { slug: 'done', title: 'Finish' },
] as const;

export type SetupStepSlug = (typeof SETUP_STEPS)[number]['slug'];

export function isSetupStep(value: string | undefined): value is SetupStepSlug {
  return SETUP_STEPS.some((step) => step.slug === value);
}

/** What every step needs from the guide around it. */
export interface StepProps {
  /** The display the guide is setting up, if one exists yet. */
  deviceId: string | null;
  go: (step: SetupStepSlug, options?: { deviceId?: string }) => void;
}

const DISMISSED_KEY = 'gca.setup.dismissed';

/**
 * Remembers, in this browser only, that someone left the guide on purpose so the
 * overview stops sending them back to it. Storage can be unavailable; the guide then
 * simply offers itself again.
 */
export function rememberSetupDismissed(): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, new Date().toISOString());
  } catch {
    // Private windows and blocked storage are fine; this is a convenience.
  }
}

/** After a reset the guide should greet this browser again. */
export function forgetSetupDismissed(): void {
  try {
    window.localStorage.removeItem(DISMISSED_KEY);
  } catch {
    // Nothing remembered, nothing to forget.
  }
}

export function setupWasDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) !== null;
  } catch {
    return false;
  }
}

/** Back on the left, the way forward on the right, an optional skip between. */
export function StepFooter({
  onBack,
  onNext,
  nextLabel = 'Continue',
  nextDisabled,
  nextBusy,
  skip,
}: {
  onBack?: () => void;
  onNext: () => void;
  nextLabel?: ReactNode;
  nextDisabled?: boolean;
  nextBusy?: boolean;
  skip?: { label: string; onClick: () => void };
}) {
  return (
    <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-line)] pt-4">
      <div>
        {onBack && (
          <Button variant="ghost" onClick={onBack}>
            ← Back
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {skip && (
          <Button variant="ghost" onClick={skip.onClick}>
            {skip.label}
          </Button>
        )}
        <Button variant="primary" disabled={nextDisabled} busy={nextBusy} onClick={onNext}>
          {nextLabel}
        </Button>
      </div>
    </div>
  );
}
