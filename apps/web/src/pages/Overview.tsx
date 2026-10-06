import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client.js';
import { useDismissProblems, useStatus } from '../api/hooks.js';
import { Banner, Button, Card, EmptyState, HealthBadge, Spinner4 } from '../components/ui.js';
import { Preview } from '../components/Preview.js';
import { profileLabel, relativeTime } from '../format.js';

export function OverviewPage() {
  const status = useStatus();
  const dismiss = useDismissProblems();
  const navigate = useNavigate();

  if (status.isLoading) return <Spinner4 />;
  if (status.isError) {
    // A 401 means the server answered, so "cannot reach" would be a lie. The app
    // shell swaps in the sign-in screen as soon as the auth state is re-read.
    const unauthorized = status.error instanceof ApiError && status.error.status === 401;
    return unauthorized ? (
      <Banner tone="warn" title="Your session ended">
        Sign in again to continue.
      </Banner>
    ) : (
      <Banner tone="bad" title="Cannot reach the server">
        {String(status.error)}
      </Banner>
    );
  }
  const data = status.data;
  if (!data) return null;

  const unfinished = data.devices.length === 0 || data.modules.length === 0;

  return (
    <div className="grid gap-5">
      {unfinished && (
        <Banner
          tone="info"
          title={data.devices.length === 0 ? 'No display yet' : 'Nothing to show yet'}
          actions={
            <Button variant="primary" onClick={() => navigate('/setup')}>
              {data.devices.length === 0 && data.modules.length === 0
                ? 'Start the setup guide'
                : 'Continue setup'}
            </Button>
          }
        >
          The setup guide walks through adding a display, choosing what it shows and the order it
          shows it in.
        </Banner>
      )}

      {data.server.authenticationRequired && (
        <Banner tone="info" title="This server is reachable from your network">
          Signing in is required. Change the administrator password in Settings.
        </Banner>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="grid gap-5">
          <Card title="Displays" description={`${data.devices.length} configured`}>
            {data.devices.length === 0 ? (
              <EmptyState title="No displays yet">
                <Link to="/setup" className="text-[var(--color-accent)] underline">
                  Open the setup guide
                </Link>{' '}
                to add your first GeekMagic display.
              </EmptyState>
            ) : (
              <ul className="grid gap-3">
                {data.devices.map((device) => (
                  <li
                    key={device.id}
                    className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] p-3"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <Link
                          to={`/devices/${device.id}`}
                          className="text-sm font-semibold text-[var(--color-ink)] hover:underline"
                        >
                          {device.name}
                        </Link>
                        <p className="mt-0.5 truncate text-xs text-[var(--color-ink-faint)]">
                          {device.host} · {profileLabel(device.profileId)}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {device.interrupted && (
                          <span className="rounded-full border border-[#5a4a1c] bg-[#241d0b] px-2 py-0.5 text-xs font-medium text-[var(--color-warn)]">
                            ▲ Interrupted
                          </span>
                        )}
                        <HealthBadge
                          status={device.health}
                          label={device.online ? undefined : 'Offline'}
                        />
                      </div>
                    </div>

                    <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
                      <div>
                        <dt className="text-[var(--color-ink-faint)]">Showing</dt>
                        <dd className="text-[var(--color-ink)]">
                          {device.currentFrame?.title ?? '—'}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[var(--color-ink-faint)]">Next</dt>
                        <dd className="text-[var(--color-ink)]">
                          {device.nextFrame?.title ?? '—'}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[var(--color-ink-faint)]">Last upload</dt>
                        <dd className="text-[var(--color-ink)]">
                          {relativeTime(device.lastUploadAt)}
                        </dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Modules" description={`${data.modules.length} configured`}>
            {data.modules.length === 0 ? (
              <EmptyState title="No modules yet">
                <Link to="/modules" className="text-[var(--color-accent)] underline">
                  Add a module
                </Link>{' '}
                to put something on the display.
              </EmptyState>
            ) : (
              <ul className="grid gap-2">
                {data.modules.map((module) => (
                  <li
                    key={module.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] p-3"
                  >
                    <div className="min-w-0">
                      <Link
                        to={`/modules/${module.id}`}
                        className="text-sm font-medium text-[var(--color-ink)] hover:underline"
                      >
                        {module.name}
                      </Link>
                      <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">
                        {module.healthMessage ??
                          `Last success ${relativeTime(module.lastSuccessAt)}`}
                      </p>
                    </div>
                    <HealthBadge status={module.health} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        {data.devices[0] && (
          <Card title="Now showing" className="lg:w-[320px]">
            <Preview
              path={`/devices/${data.devices[0].id}/preview`}
              label={`Current frame on ${data.devices[0].name}`}
              size={240}
              refreshMs={8_000}
            />
            <p className="mt-2 text-xs text-[var(--color-ink-faint)]">
              {data.devices[0].name} · refreshes every 8s
            </p>
          </Card>
        )}
      </div>

      <Card
        title="Recent problems"
        description="Only actionable errors appear here."
        actions={
          data.recentErrors.length > 0 && (
            <Button
              variant="ghost"
              busy={dismiss.isPending && !dismiss.variables?.ids}
              onClick={() => dismiss.mutate({})}
            >
              Clear all
            </Button>
          )
        }
      >
        {dismiss.isError && (
          <div className="mb-3">
            <Banner tone="bad">{String(dismiss.error)}</Banner>
          </div>
        )}
        {data.recentErrors.length === 0 ? (
          <p className="text-sm text-[var(--color-ink-muted)]">Nothing to report.</p>
        ) : (
          <ul className="grid gap-2">
            {data.recentErrors.map((entry) => (
              <li
                key={entry.id}
                className="rounded-lg border border-[#5c2330] bg-[#2a1118] p-3 text-sm"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-mono text-xs text-[var(--color-bad)]">{entry.code}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-[var(--color-ink-faint)]">
                      {relativeTime(entry.at)}
                    </span>
                    <Button
                      variant="ghost"
                      className="-my-1 px-2 py-1 text-xs"
                      aria-label={`Clear ${entry.code}`}
                      busy={dismiss.isPending && dismiss.variables?.ids?.includes(entry.id)}
                      onClick={() => dismiss.mutate({ ids: [entry.id] })}
                    >
                      ✕
                    </Button>
                  </div>
                </div>
                <p className="mt-1 text-[var(--color-ink-muted)]">{entry.message}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
