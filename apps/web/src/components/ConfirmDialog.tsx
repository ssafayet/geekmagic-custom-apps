import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button } from './ui.js';

/**
 * Modal confirmation for destructive actions.
 *
 * Always states the concrete target and consequence, never a generic "are you sure";
 * the caller passes the exact list of what will change.
 */
export function ConfirmDialog({
  open,
  title,
  consequence,
  confirmLabel,
  destructive,
  busy,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  consequence: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  const titleId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-lg rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-1)] p-5 shadow-2xl"
      >
        <h2 id={titleId} className="text-base font-semibold text-[var(--color-ink)]">
          {title}
        </h2>
        <div className="mt-2 text-sm text-[var(--color-ink-muted)]">{consequence}</div>
        {children && <div className="mt-3">{children}</div>}
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            ref={confirmRef}
            type="button"
            variant={destructive ? 'danger' : 'primary'}
            onClick={onConfirm}
            busy={busy}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
