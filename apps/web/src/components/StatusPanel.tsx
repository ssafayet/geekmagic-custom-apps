import clsx from 'clsx';
import type { StatusPanelDto } from '../api/types.js';

/** Module-supplied read-only status, rendered generically. */
export function StatusPanel({ panel }: { panel: StatusPanelDto }) {
  return (
    <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] p-3">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
        {panel.title}
      </h4>
      <dl className="grid gap-0">
        {panel.rows.map((row, index) => (
          <div
            key={`${row.label}-${index}`}
            className="border-b border-[var(--color-line)] py-1.5 last:border-0"
          >
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-xs text-[var(--color-ink-faint)]">{row.label}</dt>
              <dd
                className={clsx(
                  'truncate text-right text-sm font-medium',
                  row.tone === 'good' && 'text-[var(--color-ok)]',
                  row.tone === 'warn' && 'text-[var(--color-warn)]',
                  row.tone === 'bad' && 'text-[var(--color-bad)]',
                  (!row.tone || row.tone === 'neutral') && 'text-[var(--color-ink)]',
                )}
                title={row.value}
              >
                {row.value}
              </dd>
            </div>
            {row.hint && <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">{row.hint}</p>}
          </div>
        ))}
      </dl>
    </div>
  );
}
