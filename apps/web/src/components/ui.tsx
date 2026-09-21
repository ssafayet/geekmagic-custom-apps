import clsx from 'clsx';
import type { ReactNode } from 'react';
import type { HealthStatus } from '../api/types.js';

export function Card({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={clsx(
        'rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-1)] p-4 sm:p-5',
        className,
      )}
    >
      {(title || actions) && (
        <header className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <h2 className="text-base font-semibold text-[var(--color-ink)]">{title}</h2>}
            {description && (
              <p className="mt-1 text-sm text-[var(--color-ink-muted)]">{description}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  busy?: boolean;
  /** React 19 passes refs through props; the confirm dialog focuses its action. */
  ref?: React.Ref<HTMLButtonElement>;
};

export function Button({
  variant = 'secondary',
  busy,
  children,
  className,
  ref,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      ref={ref}
      disabled={rest.disabled || busy}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' &&
          'bg-[var(--color-accent)] text-[#12081f] hover:bg-[#c29dff] focus-visible:bg-[#c29dff]',
        variant === 'secondary' &&
          'border border-[var(--color-line)] bg-[var(--color-surface-2)] text-[var(--color-ink)] hover:bg-[var(--color-surface-3)]',
        variant === 'ghost' &&
          'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]',
        variant === 'danger' &&
          'border border-[#5c2330] bg-[#2a1118] text-[var(--color-bad)] hover:bg-[#3a141d]',
        className,
      )}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

const HEALTH_LABEL: Record<HealthStatus, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  error: 'Error',
  unknown: 'Unknown',
  disabled: 'Disabled',
};

/**
 * Health is never conveyed by colour alone: every badge carries a word and a shape,
 * so it survives a monochrome display or colour-blind reading.
 */
export function HealthBadge({ status, label }: { status: HealthStatus; label?: string }) {
  const glyph = { healthy: '●', degraded: '▲', error: '✕', unknown: '○', disabled: '–' }[status];
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium',
        status === 'healthy' && 'border-[#1d4d36] bg-[#0e2419] text-[var(--color-ok)]',
        status === 'degraded' && 'border-[#5a4a1c] bg-[#241d0b] text-[var(--color-warn)]',
        status === 'error' && 'border-[#5c2330] bg-[#2a1118] text-[var(--color-bad)]',
        status === 'unknown' &&
          'border-[var(--color-line)] bg-[var(--color-surface-2)] text-[var(--color-ink-faint)]',
        status === 'disabled' &&
          'border-[var(--color-line)] bg-[var(--color-surface-2)] text-[var(--color-ink-faint)]',
      )}
    >
      <span aria-hidden="true">{glyph}</span>
      {label ?? HEALTH_LABEL[status]}
    </span>
  );
}

export function Field({
  label,
  htmlFor,
  help,
  error,
  unit,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  help?: ReactNode;
  error?: string | undefined;
  unit?: string | undefined;
  children: ReactNode;
}) {
  const helpId = htmlFor ? `${htmlFor}-help` : undefined;
  const errorId = htmlFor ? `${htmlFor}-error` : undefined;
  return (
    <div className="grid gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-[var(--color-ink)]">
        {label}
        {unit && (
          <span className="ml-1 text-xs font-normal text-[var(--color-ink-faint)]">({unit})</span>
        )}
      </label>
      {children}
      {help && (
        <p id={helpId} className="text-xs leading-relaxed text-[var(--color-ink-faint)]">
          {help}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs font-medium text-[var(--color-bad)]">
          {error}
        </p>
      )}
    </div>
  );
}

export const inputClass =
  'w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[var(--color-ink)] placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-accent)] focus:outline-none';

export function Switch({
  checked,
  onChange,
  id,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  id?: string;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative inline-flex h-6 w-11 shrink-0 rounded-full border transition-colors disabled:opacity-50',
        checked
          ? 'border-[var(--color-accent)] bg-[var(--color-accent)]'
          : 'border-[var(--color-line)] bg-[var(--color-surface-3)]',
      )}
    >
      <span
        className={clsx(
          'absolute top-0.5 size-4.5 rounded-full bg-white transition-transform',
          checked ? 'translate-x-5.5' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

export function Banner({
  tone = 'info',
  title,
  children,
  actions,
}: {
  tone?: 'info' | 'warn' | 'bad' | 'ok';
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div
      role={tone === 'bad' ? 'alert' : 'status'}
      className={clsx(
        'rounded-lg border p-3 text-sm',
        tone === 'info' && 'border-[#1f3c5e] bg-[#0b1929] text-[var(--color-ink)]',
        tone === 'warn' && 'border-[#5a4a1c] bg-[#241d0b] text-[var(--color-ink)]',
        tone === 'bad' && 'border-[#5c2330] bg-[#2a1118] text-[var(--color-ink)]',
        tone === 'ok' && 'border-[#1d4d36] bg-[#0e2419] text-[var(--color-ink)]',
      )}
    >
      {title && <p className="font-semibold">{title}</p>}
      {children && (
        <div className={clsx('text-[var(--color-ink-muted)]', title && 'mt-1')}>{children}</div>
      )}
      {actions && <div className="mt-3 flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-[var(--color-line)] p-6 text-center">
      <p className="text-sm font-medium text-[var(--color-ink)]">{title}</p>
      {children && <div className="mt-2 text-sm text-[var(--color-ink-muted)]">{children}</div>}
    </div>
  );
}

export function Spinner4() {
  return (
    <div className="flex items-center gap-2 text-sm text-[var(--color-ink-muted)]">
      <Spinner />
      Loading…
    </div>
  );
}

export function Kv({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: 'good' | 'warn' | 'bad' | 'neutral';
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-[var(--color-line)] py-1.5 last:border-0">
      <dt className="text-xs uppercase tracking-wide text-[var(--color-ink-faint)]">{label}</dt>
      <dd
        className={clsx(
          'text-right text-sm font-medium',
          tone === 'good' && 'text-[var(--color-ok)]',
          tone === 'warn' && 'text-[var(--color-warn)]',
          tone === 'bad' && 'text-[var(--color-bad)]',
          (!tone || tone === 'neutral') && 'text-[var(--color-ink)]',
        )}
      >
        {value}
      </dd>
    </div>
  );
}
