import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { previewUrl } from '../api/client.js';

/**
 * Live 240x240 preview.
 *
 * Rendered at 2x on screen with crisp scaling so the panel reads the way it will on
 * the device rather than being smoothed into something prettier than reality.
 */
export function Preview({
  path,
  refreshMs = 10_000,
  size = 240,
  label,
  className,
}: {
  path: string;
  refreshMs?: number;
  size?: number;
  label: string;
  className?: string;
}) {
  const [version, setVersion] = useState(() => Date.now());
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (refreshMs <= 0) return;
    const timer = setInterval(() => setVersion(Date.now()), refreshMs);
    return () => clearInterval(timer);
  }, [refreshMs]);

  useEffect(() => {
    setFailed(false);
    setVersion(Date.now());
  }, [path]);

  return (
    <div
      className={clsx(
        'relative overflow-hidden rounded-lg border border-[var(--color-line)] bg-black',
        className,
      )}
      style={{ width: size, height: size }}
    >
      {failed ? (
        <div className="flex h-full items-center justify-center p-4 text-center text-xs text-[var(--color-ink-faint)]">
          No preview yet
        </div>
      ) : (
        <img
          src={previewUrl(path, version)}
          alt={label}
          width={size}
          height={size}
          onError={() => setFailed(true)}
          className="size-full"
          style={{ imageRendering: size > 240 ? 'pixelated' : 'auto' }}
        />
      )}
    </div>
  );
}
