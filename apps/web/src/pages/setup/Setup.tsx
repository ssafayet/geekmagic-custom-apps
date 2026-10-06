import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { useDevices, useModuleInstances, usePlaylist, useSettings } from '../../api/hooks.js';
import { Banner, Button, Card, HealthBadge, Spinner4 } from '../../components/ui.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Preview } from '../../components/Preview.js';
import { PlaylistEditor } from '../DisplayOrder.js';
import { relativeTime } from '../../format.js';
import { CheckStep, DisplayStep } from './DisplaySteps.js';
import { ModulesStep } from './ModulesStep.js';
import { PreferencesStep } from './PreferencesStep.js';
import {
  SETUP_STEPS,
  StepFooter,
  isSetupStep,
  rememberSetupDismissed,
  type SetupStepSlug,
  type StepProps,
} from './shared.js';
import type { DeviceDto, ModuleInstanceDto, PlaylistItemDto } from '../../api/types.js';

/**
 * The setup guide: one page per step, each addressable, so a reload or a detour to
 * another tab comes back to the same place.
 *
 * Every step can be skipped and the guide adds nothing that was not asked for. It
 * reuses the same editors as the rest of the app, so what it teaches is what the
 * regular pages look like afterwards.
 */
export function SetupPage() {
  const { step } = useParams<{ step: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const devices = useDevices();
  const instances = useModuleInstances();
  const settings = useSettings();

  const device =
    devices.data?.find((candidate) => candidate.id === params.get('display')) ??
    devices.data?.[0] ??
    null;
  const deviceId = device?.id ?? null;
  const playlist = usePlaylist(deviceId ?? undefined);

  // Block body: newer browsers return a promise from scrollTo, which React would
  // otherwise treat as this effect's cleanup.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [step]);

  const go: StepProps['go'] = (target, options) => {
    const id = options?.deviceId ?? deviceId;
    navigate(`/setup/${target}${id ? `?display=${encodeURIComponent(id)}` : ''}`);
  };

  if (devices.isLoading || instances.isLoading) return <Spinner4 />;

  if (!isSetupStep(step)) {
    const resume = resumeStep(devices.data ?? [], instances.data ?? [], device);
    return (
      <Navigate
        to={`/setup/${resume}${deviceId ? `?display=${encodeURIComponent(deviceId)}` : ''}`}
        replace
      />
    );
  }

  const currentIndex = SETUP_STEPS.findIndex((candidate) => candidate.slug === step);
  const themeName = settings.data?.themes.find((theme) => theme.id === settings.data?.theme);
  const progress = describeProgress({
    currentIndex,
    device,
    modules: instances.data ?? [],
    playlist: playlist.data ?? [],
    preferences: settings.data
      ? `${settings.data.displayTimezone} · ${themeName?.displayName ?? settings.data.theme}`
      : null,
  });
  const props: StepProps = { deviceId, go };

  return (
    <div className="grid gap-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-[var(--color-ink)]">
          Set up your display
        </h1>
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          A few short steps from a blank display to a rotation of live screens.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[230px_minmax(0,1fr)]">
        <aside>
          <div className="lg:hidden">
            <p className="text-xs font-medium text-[var(--color-ink-faint)]">
              Step {currentIndex + 1} of {SETUP_STEPS.length}
            </p>
            <div
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-2)]"
              role="progressbar"
              aria-label="Setup progress"
              aria-valuemin={1}
              aria-valuemax={SETUP_STEPS.length}
              aria-valuenow={currentIndex + 1}
            >
              <div
                className="h-full rounded-full bg-[var(--color-accent)] transition-[width]"
                style={{ width: `${((currentIndex + 1) / SETUP_STEPS.length) * 100}%` }}
              />
            </div>
          </div>

          <nav aria-label="Setup steps" className="hidden lg:block">
            <ol className="grid gap-1">
              {SETUP_STEPS.map((candidate, index) => {
                const state = progress[candidate.slug];
                const current = candidate.slug === step;
                return (
                  <li key={candidate.slug}>
                    <button
                      type="button"
                      onClick={() => go(candidate.slug)}
                      aria-current={current ? 'step' : undefined}
                      className={clsx(
                        'flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left transition-colors',
                        current
                          ? 'bg-[var(--color-surface-2)]'
                          : 'hover:bg-[var(--color-surface-1)]',
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={clsx(
                          'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold',
                          current
                            ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                            : state.done
                              ? 'border-[#1d4d36] bg-[#0e2419] text-[var(--color-ok)]'
                              : 'border-[var(--color-line)] text-[var(--color-ink-faint)]',
                        )}
                      >
                        {state.done && !current ? '✓' : index + 1}
                      </span>
                      <span className="min-w-0">
                        <span
                          className={clsx(
                            'block text-sm font-medium',
                            current || state.done
                              ? 'text-[var(--color-ink)]'
                              : 'text-[var(--color-ink-muted)]',
                          )}
                        >
                          {candidate.title}
                          {state.done && <span className="sr-only"> (done)</span>}
                        </span>
                        {state.summary && (
                          <span className="block truncate text-xs text-[var(--color-ink-faint)]">
                            {state.summary}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>
        </aside>

        <div className="min-w-0">
          {step === 'welcome' && <WelcomeStep {...props} />}
          {step === 'preferences' && <PreferencesStep {...props} />}
          {step === 'display' && <DisplayStep {...props} />}
          {step === 'check' && <CheckStep {...props} />}
          {step === 'modules' && <ModulesStep {...props} />}
          {step === 'order' && <OrderStep {...props} />}
          {step === 'done' && (
            <DoneStep
              {...props}
              device={device}
              modules={instances.data ?? []}
              playlist={playlist.data ?? []}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** Where someone returning to the guide most likely left off. */
function resumeStep(
  devices: DeviceDto[],
  modules: ModuleInstanceDto[],
  device: DeviceDto | null,
): SetupStepSlug {
  if (devices.length === 0 && modules.length === 0) return 'welcome';
  if (devices.length === 0) return 'display';
  if (device?.capabilities.requiresAlbumManagement && !device.albumManagementConsent) {
    return 'check';
  }
  if (modules.length === 0) return 'modules';
  return 'order';
}

function describeProgress({
  currentIndex,
  device,
  modules,
  playlist,
  preferences,
}: {
  currentIndex: number;
  device: DeviceDto | null;
  modules: ModuleInstanceDto[];
  playlist: PlaylistItemDto[];
  preferences: string | null;
}): Record<SetupStepSlug, { done: boolean; summary: string | null }> {
  const needsConsent = Boolean(
    device?.capabilities.requiresAlbumManagement && !device.albumManagementConsent,
  );
  const rotating = playlist.filter((item) => item.enabled).length;
  const failing = modules.filter((module) => module.healthStatus === 'error').length;
  return {
    welcome: { done: currentIndex > 0, summary: null },
    preferences: { done: currentIndex > 1, summary: preferences },
    display: { done: device !== null, summary: device?.name ?? 'Not added yet' },
    check: {
      done: device !== null && device.lastUploadAt !== null && !needsConsent,
      summary: !device
        ? null
        : needsConsent
          ? 'Needs album setup'
          : device.lastUploadAt
            ? 'Receiving frames'
            : 'Not checked yet',
    },
    modules: {
      done: modules.length > 0 && failing === 0,
      summary:
        modules.length === 0
          ? 'None yet'
          : failing > 0
            ? `${failing} need${failing === 1 ? 's' : ''} settings`
            : `${modules.length} added`,
    },
    order: {
      done: rotating > 0,
      summary: device ? `${rotating} screen${rotating === 1 ? '' : 's'} rotating` : null,
    },
    done: { done: false, summary: null },
  };
}

function WelcomeStep({ go }: StepProps) {
  const navigate = useNavigate();
  return (
    <Card title="Welcome">
      <div className="grid gap-4 text-sm leading-relaxed text-[var(--color-ink-muted)]">
        <p>
          This app draws small information screens — usage limits, the weather, your next meeting,
          aircraft overhead — and sends them to a GeekMagic display over its existing Wi-Fi
          connection. Nothing is installed on the display and its firmware is not changed.
        </p>

        <div>
          <p className="font-medium text-[var(--color-ink)]">What you will do</p>
          <ol className="mt-2 grid gap-1.5">
            <li>1. Pick a time zone, colours and how long each screen stays up.</li>
            <li>2. Add your display by its address and send it a test picture.</li>
            <li>3. Choose the screens you want and fill in what each one needs.</li>
            <li>4. Check the order they rotate in.</li>
          </ol>
        </div>

        <div>
          <p className="font-medium text-[var(--color-ink)]">Have ready</p>
          <ul className="mt-2 grid gap-1.5">
            <li>· The display, powered on and on the same Wi-Fi as this computer.</li>
            <li>
              · Its IP address, shown on the display as it starts up. The guide can also look for
              it.
            </li>
          </ul>
        </div>

        <Banner tone="info" title="It all stays on your network">
          No account is needed and nothing is sent to a cloud service. Device requests only go to
          private network addresses, and a module only contacts the services listed on its card.
        </Banner>
      </div>

      <StepFooter
        onNext={() => go('preferences')}
        nextLabel="Get started"
        skip={{
          label: 'Skip setup',
          onClick: () => {
            rememberSetupDismissed();
            navigate('/');
          },
        }}
      />
    </Card>
  );
}

function OrderStep({ deviceId, go }: StepProps) {
  const devices = useDevices();
  const [dirty, setDirty] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<SetupStepSlug | null>(null);

  const leave = (target: SetupStepSlug) => (dirty ? setPendingLeave(target) : go(target));

  if (!deviceId) {
    return (
      <Card title="Display order">
        <Banner tone="warn">
          There is no display to arrange yet. Add one and every module you set up joins its rotation
          automatically.
        </Banner>
        <StepFooter onBack={() => go('modules')} onNext={() => go('done')} />
      </Card>
    );
  }

  return (
    <div className="grid gap-5">
      <Banner tone="info" title="Already filled in for you">
        Every module you added was placed in this display&rsquo;s rotation. Move screens up or down,
        change how long each one stays, switch one off, or add a module&rsquo;s other views — then
        save.
        {(devices.data?.length ?? 0) > 1 &&
          ' Your other displays can be arranged later on the Display order page.'}
      </Banner>

      <PlaylistEditor key={deviceId} deviceId={deviceId} onDirtyChange={setDirty} />

      <StepFooter onBack={() => leave('modules')} onNext={() => leave('done')} />

      <ConfirmDialog
        open={pendingLeave !== null}
        title="Leave without saving the order?"
        confirmLabel="Discard changes"
        destructive
        consequence="Your changes to the display order have not been saved."
        onCancel={() => setPendingLeave(null)}
        onConfirm={() => {
          const target = pendingLeave;
          setPendingLeave(null);
          if (target) go(target);
        }}
      />
    </div>
  );
}

function DoneStep({
  go,
  device,
  modules,
  playlist,
}: StepProps & {
  device: DeviceDto | null;
  modules: ModuleInstanceDto[];
  playlist: PlaylistItemDto[];
}) {
  const navigate = useNavigate();
  const rotating = playlist.filter((item) => item.enabled);
  const cycleSeconds = rotating.reduce((total, item) => total + item.dwellSeconds, 0);
  const needsConsent = Boolean(
    device?.capabilities.requiresAlbumManagement && !device.albumManagementConsent,
  );
  // A module in error is on the display, but only as a message asking for settings.
  const failing = modules.filter((module) => module.healthStatus === 'error');

  const checks: Array<{ ok: boolean; label: string; detail: string; fix: SetupStepSlug }> = [
    {
      ok: device !== null,
      label: 'Display added',
      detail: device ? `${device.name} at ${device.host}` : 'No display yet.',
      fix: 'display',
    },
    {
      ok: Boolean(device?.lastUploadAt) && !needsConsent,
      label: 'Display receiving frames',
      detail: needsConsent
        ? 'The picture album still needs to be set up.'
        : device?.lastUploadAt
          ? `Last frame ${relativeTime(device.lastUploadAt)}.`
          : 'Nothing has been sent yet. Try a test frame.',
      fix: 'check',
    },
    {
      ok: modules.length > 0 && failing.length === 0,
      label: 'Modules set up',
      detail:
        modules.length === 0
          ? 'No modules yet, so there is nothing to show.'
          : failing.length > 0
            ? `${failing.map((module) => module.name).join(', ')} still ${failing.length === 1 ? 'needs' : 'need'} settings: ${failing[0]?.healthMessage ?? 'check the module.'}`
            : modules.map((module) => module.name).join(', '),
      fix: 'modules',
    },
    {
      ok: rotating.length > 0,
      label: 'Display order',
      detail:
        rotating.length > 0
          ? `${rotating.length} screen${rotating.length === 1 ? '' : 's'}, a full cycle every ${cycleSeconds}s.`
          : 'Nothing is in the rotation.',
      fix: 'order',
    },
  ];
  const allGood = checks.every((check) => check.ok);

  return (
    <Card
      title={allGood ? 'You are all set' : 'Almost there'}
      description={
        allGood
          ? 'The display now cycles through your screens on its own. This page can be closed.'
          : 'Setup can be finished now and picked up again later. Anything unfinished is listed below.'
      }
    >
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_auto]">
        <div className="grid content-start gap-4">
          <ul className="grid gap-2">
            {checks.map((check) => (
              <li
                key={check.label}
                className="flex items-start justify-between gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] p-3"
              >
                <div className="flex min-w-0 gap-3">
                  <span
                    aria-hidden="true"
                    className={check.ok ? 'text-[var(--color-ok)]' : 'text-[var(--color-warn)]'}
                  >
                    {check.ok ? '✓' : '○'}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-[var(--color-ink)]">
                      {check.label}
                      <span className="sr-only">{check.ok ? ' (done)' : ' (not done)'}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">{check.detail}</p>
                  </div>
                </div>
                {!check.ok && (
                  <Button className="shrink-0" onClick={() => go(check.fix)}>
                    Finish this
                  </Button>
                )}
              </li>
            ))}
          </ul>

          {modules.length > 0 && (
            <ul className="grid gap-1.5">
              {modules.map((module) => (
                <li key={module.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="truncate text-[var(--color-ink-muted)]">{module.name}</span>
                  <HealthBadge status={module.healthStatus} />
                </li>
              ))}
            </ul>
          )}

          <p className="text-xs leading-relaxed text-[var(--color-ink-faint)]">
            Everything here can be changed later from{' '}
            <Link className="underline hover:text-[var(--color-ink)]" to="/devices">
              Devices
            </Link>
            ,{' '}
            <Link className="underline hover:text-[var(--color-ink)]" to="/modules">
              Modules
            </Link>
            ,{' '}
            <Link className="underline hover:text-[var(--color-ink)]" to="/display-order">
              Display order
            </Link>{' '}
            and{' '}
            <Link className="underline hover:text-[var(--color-ink)]" to="/settings">
              Settings
            </Link>
            . This guide stays available from the overview.
          </p>
        </div>

        {device && (
          <div className="grid content-start justify-items-center gap-2">
            <Preview
              path={`/devices/${device.id}/preview`}
              label={`Now showing on ${device.name}`}
              size={200}
              refreshMs={8_000}
            />
            <p className="text-xs text-[var(--color-ink-faint)]">Now showing</p>
          </div>
        )}
      </div>

      <StepFooter
        onBack={() => go('order')}
        nextLabel="Go to the overview"
        onNext={() => {
          rememberSetupDismissed();
          navigate('/');
        }}
      />
    </Card>
  );
}
