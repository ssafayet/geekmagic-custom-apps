import { NavLink, Route, Routes, Navigate } from 'react-router-dom';
import clsx from 'clsx';
import { useHealth, useStatus } from './api/hooks.js';
import { OverviewPage } from './pages/Overview.js';
import { DevicesPage } from './pages/Devices.js';
import { ModulesPage } from './pages/Modules.js';
import { DisplayOrderPage } from './pages/DisplayOrder.js';
import { SettingsPage } from './pages/Settings.js';
import { DiagnosticsPage } from './pages/Diagnostics.js';
import { OnboardingPage } from './pages/Onboarding.js';

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
  const status = useStatus();

  // A first run has nothing configured yet; send the user through setup instead of
  // an overview full of empty cards.
  const needsOnboarding =
    status.isSuccess && status.data.devices.length === 0 && status.data.modules.length === 0;

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
            {health.isError && (
              <span className="text-xs font-medium text-[var(--color-bad)]">
                Server unreachable
              </span>
            )}
          </div>

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
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
        <Routes>
          <Route
            path="/"
            element={needsOnboarding ? <Navigate to="/setup" replace /> : <OverviewPage />}
          />
          <Route path="/setup" element={<OnboardingPage />} />
          <Route path="/devices" element={<DevicesPage />} />
          <Route path="/devices/:deviceId" element={<DevicesPage />} />
          <Route path="/modules" element={<ModulesPage />} />
          <Route path="/modules/:instanceId" element={<ModulesPage />} />
          <Route path="/display-order" element={<DisplayOrderPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/diagnostics" element={<DiagnosticsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <footer className="border-t border-[var(--color-line)] px-4 py-3 text-center text-xs text-[var(--color-ink-faint)] sm:px-6">
        Local-first. No telemetry. Aircraft data from adsb.fi.
      </footer>
    </div>
  );
}
