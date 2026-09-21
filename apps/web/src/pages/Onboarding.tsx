import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import {
  useCreateInstance,
  useDeviceAction,
  useDevices,
  useModuleDefinitions,
  useModuleInstances,
  useSavePlaylist,
} from '../api/hooks.js';
import { Banner, Button, Card, Spinner4 } from '../components/ui.js';
import { Preview } from '../components/Preview.js';
import { AddDeviceForm } from './AddDeviceForm.js';
import { profileLabel } from '../format.js';

const STEPS = [
  'Welcome',
  'Add a display',
  'Check it works',
  'Add modules',
  'Display order',
] as const;

/**
 * First-run walkthrough.
 *
 * Every step is skippable and the wizard adds nothing the user did not ask for; it
 * exists so the first five minutes do not require reading the documentation.
 */
export function OnboardingPage() {
  const [step, setStep] = useState(0);
  const devices = useDevices();
  const navigate = useNavigate();

  const device = devices.data?.[0];

  return (
    <div className="grid gap-5">
      <ol className="flex flex-wrap gap-2" aria-label="Setup progress">
        {STEPS.map((label, index) => (
          <li key={label}>
            <button
              type="button"
              onClick={() => setStep(index)}
              aria-current={index === step ? 'step' : undefined}
              className={clsx(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                index === step
                  ? 'border-[var(--color-accent)] bg-[var(--color-surface-2)] text-[var(--color-ink)]'
                  : index < step
                    ? 'border-[#1d4d36] bg-[#0e2419] text-[var(--color-ok)]'
                    : 'border-[var(--color-line)] text-[var(--color-ink-faint)]',
              )}
            >
              {index < step ? '✓ ' : `${index + 1}. `}
              {label}
            </button>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <Card title="Welcome">
          <div className="grid gap-3 text-sm text-[var(--color-ink-muted)]">
            <p>
              This service renders small information screens and pushes them to a stock GeekMagic
              display over its existing HTTP API. Nothing is installed on the display and its
              firmware is not modified.
            </p>
            <Banner tone="info" title="How it stays local">
              The server listens on 127.0.0.1 by default. No account is needed, nothing is sent to a
              cloud service, and device requests are restricted to private network addresses.
            </Banner>
            <p>
              Setup takes about five minutes: add a display, confirm it receives a test frame, then
              enable the modules you want.
            </p>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => navigate('/')}>
              Skip setup
            </Button>
            <Button variant="primary" onClick={() => setStep(1)}>
              Get started
            </Button>
          </div>
        </Card>
      )}

      {step === 1 && (
        <Card title="Add a display" description="Detection is read-only; nothing is written yet.">
          {devices.isLoading ? (
            <Spinner4 />
          ) : (
            <>
              {(devices.data ?? []).length > 0 && (
                <div className="mb-4">
                  <Banner tone="ok" title="Already added">
                    {(devices.data ?? []).map((existing) => (
                      <div key={existing.id}>
                        {existing.name} — {profileLabel(existing.profileId)}
                      </div>
                    ))}
                  </Banner>
                </div>
              )}
              <AddDeviceForm onAdded={() => setStep(2)} />
            </>
          )}
          <div className="mt-4 flex justify-between">
            <Button variant="ghost" onClick={() => setStep(0)}>
              Back
            </Button>
            <Button disabled={(devices.data ?? []).length === 0} onClick={() => setStep(2)}>
              Continue
            </Button>
          </div>
        </Card>
      )}

      {step === 2 && device && (
        <VerifyStep deviceId={device.id} onNext={() => setStep(3)} onBack={() => setStep(1)} />
      )}
      {step === 2 && !device && (
        <Card title="Check it works">
          <Banner tone="warn">Add a display first.</Banner>
          <div className="mt-4">
            <Button onClick={() => setStep(1)}>Back</Button>
          </div>
        </Card>
      )}

      {step === 3 && <ModulesStep onNext={() => setStep(4)} onBack={() => setStep(2)} />}

      {step === 4 && (
        <Card title="Display order">
          <p className="text-sm text-[var(--color-ink-muted)]">
            Arrange which module views rotate on the display and how long each is shown. An ADS-B
            overhead alert can interrupt the rotation and hand it back afterwards.
          </p>
          <div className="mt-4 flex flex-wrap justify-between gap-2">
            <Button variant="ghost" onClick={() => setStep(3)}>
              Back
            </Button>
            <div className="flex gap-2">
              <Button onClick={() => navigate('/display-order')}>Open display order</Button>
              <Button variant="primary" onClick={() => navigate('/')}>
                Finish
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

function VerifyStep({
  deviceId,
  onNext,
  onBack,
}: {
  deviceId: string;
  onNext: () => void;
  onBack: () => void;
}) {
  const devices = useDevices();
  const action = useDeviceAction(deviceId);
  const [result, setResult] = useState<{ tone: 'ok' | 'warn' | 'bad'; text: string } | null>(null);

  const device = devices.data?.find((candidate) => candidate.id === deviceId);
  const needsConsent =
    device?.capabilities.requiresAlbumManagement && !device.albumManagementConsent;

  return (
    <Card title="Check it works">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="grid gap-3">
          {needsConsent ? (
            <Banner tone="warn" title="This model needs managed-album setup first">
              Picture mode on this display is an album slideshow. Open the display on the Devices
              page to review exactly which pictures would be removed, back them up and take over.
            </Banner>
          ) : (
            <p className="text-sm text-[var(--color-ink-muted)]">
              Send a test frame and confirm it appears on the display.
            </p>
          )}

          {result && (
            <Banner tone={result.tone === 'ok' ? 'ok' : result.tone}>{result.text}</Banner>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={needsConsent}
              busy={action.isPending}
              onClick={async () => {
                setResult(null);
                try {
                  const response = (await action.mutateAsync({ action: 'test-frame' })) as {
                    status?: string;
                    warning?: string | null;
                  };
                  setResult(
                    response.warning
                      ? { tone: 'warn', text: response.warning }
                      : { tone: 'ok', text: 'Test frame delivered. Check the display.' },
                  );
                } catch (error) {
                  setResult({ tone: 'bad', text: String(error) });
                }
              }}
            >
              Send test frame
            </Button>
            {needsConsent && (
              <Link to={`/devices/${deviceId}`}>
                <Button>Open device setup</Button>
              </Link>
            )}
          </div>

          {device?.profileId === 'stock-pro' && (
            <Banner tone="info">
              On a SmallTV-PRO, open the Picture app once on the device itself and confirm the
              dashboard is shown. That step cannot be done reliably over the network.
            </Banner>
          )}
        </div>

        <Preview
          path={`/devices/${deviceId}/preview`}
          label="Device preview"
          size={200}
          refreshMs={6_000}
        />
      </div>

      <div className="mt-4 flex justify-between">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onNext}>Continue</Button>
      </div>
    </Card>
  );
}

function ModulesStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const definitions = useModuleDefinitions();
  const instances = useModuleInstances();
  const create = useCreateInstance();
  const navigate = useNavigate();

  if (definitions.isLoading || instances.isLoading) return <Spinner4 />;

  return (
    <Card title="Add modules" description="You can add or remove these at any time.">
      <ul className="grid gap-3 sm:grid-cols-2">
        {(definitions.data ?? []).map((definition) => {
          const existing = (instances.data ?? []).filter(
            (instance) => instance.moduleId === definition.id,
          );
          return (
            <li
              key={definition.id}
              className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] p-3"
            >
              <h3 className="text-sm font-semibold text-[var(--color-ink)]">
                {definition.displayName}
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-[var(--color-ink-muted)]">
                {definition.description}
              </p>
              <div className="mt-3">
                {existing.length > 0 ? (
                  <Button onClick={() => navigate(`/modules/${existing[0]?.id}`)}>Configure</Button>
                ) : (
                  <Button
                    variant="primary"
                    busy={create.isPending}
                    onClick={async () => {
                      const instance = await create.mutateAsync({ moduleId: definition.id });
                      navigate(`/modules/${instance.id}`);
                    }}
                  >
                    Add {definition.displayName}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="mt-4 flex justify-between">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onNext}>Continue</Button>
      </div>
    </Card>
  );
}
