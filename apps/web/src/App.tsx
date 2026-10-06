import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import clsx from 'clsx';
import { useAuthState, useHealth, useLogout, useStatus } from './api/hooks.js';
import { Button, Spinner4 } from './components/ui.js';
import { OverviewPage } from './pages/Overview.js';
import { DevicesPage } from './pages/Devices.js';
import { ModulesPage } from './pages/Modules.js';
import { DisplayOrderPage } from './pages/DisplayOrder.js';
import { SettingsPage } from './pages/Settings.js';
import { DiagnosticsPage } from './pages/Diagnostics.js';
import { SetupPage } from './pages/setup/Setup.js';
import { rememberSetupDismissed, setupWasDismissed } from './pages/setup/shared.js';
import { SignInPage } from './pages/SignIn.js';

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/devices', label: 'Devices' },
  { to: '/modules', label: 'Modules' },
  { to: '/display-order', label: 'Display order' },
  { to: '/settings', label: 'Settings' },
  { to: '/diagnostics', label: 'Diagnostics' },
];

export function App() {
  const health = useHealth();
  const auth = useAuthState();
  const logout = useLogout();
  // The setup guide is a focused flow; the section links would only pull people out of it.
  const inSetup = useLocation().pathname.startsWith('/setup');

  // An unreachable server is not a locked one: fall through and let the pages say so.
  const locked = auth.data ? auth.data.required && !auth.data.authenticated : false;
  const signedIn = auth.data ? auth.data.required && auth.data.authenticated : false;

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-[var(--color-line)] bg-[var(--color-surface-0)]/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-baseline gap-3">
              <span className="text-sm font-semibold tracking-tight text-[var(--color-ink)]">
                geekmagic-custom-apps
              </span>
              <span className="hidden text-xs text-[var(--color-ink-faint)] sm:inline">
                v{health.data?.version ?? '—'}
              </span>
            </div>
            <div className="flex items-center gap-3">
              {inSetup && !locked && (
                <Link
                  to="/"
                  onClick={rememberSetupDismissed}
                  className="text-sm font-medium text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
                >
                  Exit setup
                </Link>
              )}
              {health.isError && (
                <span className="text-xs font-medium text-[var(--color-bad)]">
                  Server unreachable
                </span>
              )}
              {signedIn && (
                <Button variant="ghost" busy={logout.isPending} onClick={() => logout.mutate()}>
                  Sign out
                </Button>
              )}
            </div>
          </div>

          {!locked && !inSetup && (
            <nav aria-label="Sections" className="-mx-1 overflow-x-auto">
              <ul className="flex gap-1">
                {NAV.map((item) => (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.end}
                      className={({ isActive }) =>
                        clsx(
                          'block whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                          isActive
                            ? 'bg-[var(--color-surface-2)] text-[var(--color-ink)]'
                            : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-1)] hover:text-[var(--color-ink)]',
                        )
                      }
                    >
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </nav>
          )}
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
        {auth.isLoading ? (
          <Spinner4 />
        ) : locked ? (
          <SignInPage configured={auth.data?.configured ?? false} />
        ) : (
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/setup" element={<SetupPage />} />
            <Route path="/setup/:step" element={<SetupPage />} />
            <Route path="/devices" element={<DevicesPage />} />
            <Route path="/devices/:deviceId" element={<DevicesPage />} />
            <Route path="/modules" element={<ModulesPage />} />
            <Route path="/modules/:instanceId" element={<ModulesPage />} />
            <Route path="/display-order" element={<DisplayOrderPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/diagnostics" element={<DiagnosticsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </main>

      <footer className="border-t border-[var(--color-line)] px-4 py-3 text-center text-xs text-[var(--color-ink-faint)] sm:px-6">
        Local-first. No telemetry. Aircraft data from adsb.fi.
      </footer>
    </div>
  );
}

/**
 * A first run has nothing configured yet; send it through setup, not empty cards.
 * Someone who left the guide on purpose is not sent back; the overview offers it.
 */
function Home() {
  const status = useStatus();
  const needsOnboarding =
    status.isSuccess &&
    status.data.devices.length === 0 &&
    status.data.modules.length === 0 &&
    !setupWasDismissed();
  return needsOnboarding ? <Navigate to="/setup" replace /> : <OverviewPage />;
}
