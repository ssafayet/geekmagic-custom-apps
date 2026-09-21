import { useState } from 'react';
import { ApiError } from '../api/client.js';
import { useAddDevice, useDiscoverDevices, useProbeDevice, useSubnets } from '../api/hooks.js';
import { Banner, Button, Field, Kv, inputClass } from '../components/ui.js';
import { profileLabel } from '../format.js';
import type { DeviceDto, DeviceProbeDto } from '../api/types.js';

/**
 * Manual host entry is the primary path and always available: discovery can be
 * blocked by VLANs, firewalls or an unusual subnet mask.
 */
export function AddDeviceForm({ onAdded }: { onAdded: (device: DeviceDto) => void }) {
  const [host, setHost] = useState('');
  const [probe, setProbe] = useState<DeviceProbeDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDiscovery, setShowDiscovery] = useState(false);

  const probeDevice = useProbeDevice();
  const addDevice = useAddDevice();

  const runProbe = async (candidate: string) => {
    setError(null);
    setProbe(null);
    try {
      setProbe(await probeDevice.mutateAsync({ host: candidate }));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    }
  };

  const save = async () => {
    setError(null);
    try {
      onAdded(await addDevice.mutateAsync({ host }));
      setHost('');
      setProbe(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    }
  };

  return (
    <div className="grid gap-4 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] p-4">
      <Field
        label="Display address"
        htmlFor="add-host"
        help="An IP address or hostname on your local network, for example 192.168.1.42."
      >
        <div className="flex flex-wrap gap-2">
          <input
            id="add-host"
            className={`${inputClass} flex-1`}
            placeholder="192.168.1.42"
            value={host}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setHost(event.target.value);
              setProbe(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && host.trim()) void runProbe(host.trim());
            }}
          />
          <Button
            variant="primary"
            disabled={!host.trim()}
            busy={probeDevice.isPending}
            onClick={() => void runProbe(host.trim())}
          >
            Detect
          </Button>
        </div>
      </Field>

      {error && <Banner tone="bad">{error}</Banner>}

      {probe && (
        <div className="grid gap-3">
          {!probe.reachable ? (
            <Banner tone="bad" title="Nothing responded at that address">
              Check that the display is powered on and on the same network.
            </Banner>
          ) : (
            <>
              <dl className="grid gap-x-8 sm:grid-cols-2">
                <Kv label="Profile" value={profileLabel(probe.profileId)} />
                <Kv label="Model" value={probe.modelName ?? 'not reported'} />
                <Kv label="Firmware" value={probe.firmwareVersion ?? 'not reported'} />
                <Kv
                  label="Writable"
                  value={probe.supported ? 'yes' : 'no'}
                  tone={probe.supported ? 'good' : 'bad'}
                />
              </dl>

              {probe.warnings.map((warning) => (
                <Banner key={warning} tone="warn">
                  {warning}
                </Banner>
              ))}

              {probe.capabilities.requiresAlbumManagement && (
                <Banner tone="warn" title="This model uses a picture album">
                  After adding it you will be asked to review exactly which pictures would be
                  removed before anything is deleted.
                </Banner>
              )}

              <div className="flex justify-end">
                <Button variant="primary" busy={addDevice.isPending} onClick={() => void save()}>
                  Add this display
                </Button>
              </div>
            </>
          )}

          <details className="text-xs">
            <summary className="cursor-pointer text-[var(--color-ink-muted)]">
              Detection transcript
            </summary>
            <ul className="mt-2 grid gap-1 font-mono text-[var(--color-ink-faint)]">
              {probe.transcript.map((entry, index) => (
                <li key={`${entry.step}-${index}`}>
                  {entry.outcome === 'match' ? '✓' : entry.outcome === 'error' ? '✕' : '·'}{' '}
                  {entry.path} → {entry.status ?? 'no response'} ({entry.durationMs}ms){' '}
                  {entry.detail ?? ''}
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}

      <div>
        <Button variant="ghost" onClick={() => setShowDiscovery((value) => !value)}>
          {showDiscovery ? 'Hide network discovery' : 'Discover on my network'}
        </Button>
        {showDiscovery && <DiscoveryPanel onPick={(candidate) => void runProbe(candidate)} />}
      </div>
    </div>
  );
}

function DiscoveryPanel({ onPick }: { onPick: (host: string) => void }) {
  const subnets = useSubnets();
  const discover = useDiscoverDevices();
  const [cidr, setCidr] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (subnets.isLoading)
    return <p className="mt-3 text-sm text-[var(--color-ink-muted)]">Looking for networks…</p>;
  if (!subnets.data?.enabled) {
    return (
      <div className="mt-3">
        <Banner tone="warn">Network discovery is switched off in Settings.</Banner>
      </div>
    );
  }

  const options = subnets.data.subnets;
  const selected = cidr || options[0]?.cidr || '';

  return (
    <div className="mt-3 grid gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-1)] p-3">
      <Banner tone="info">
        This scans only the subnet you choose, one time, with a one-second timeout per address.
        Nothing is scanned in the background.
      </Banner>

      {options.length === 0 ? (
        <p className="text-sm text-[var(--color-ink-muted)]">
          No private IPv4 networks were found on this machine. Enter the address by hand instead.
        </p>
      ) : (
        <>
          <Field label="Subnet to scan" htmlFor="discover-cidr">
            <select
              id="discover-cidr"
              className={inputClass}
              value={selected}
              onChange={(event) => setCidr(event.target.value)}
            >
              {options.map((option) => (
                <option key={option.cidr} value={option.cidr}>
                  {option.cidr} · {option.interfaceName} ({option.hostCount} addresses)
                </option>
              ))}
            </select>
          </Field>

          <div>
            <Button
              busy={discover.isPending}
              onClick={async () => {
                setError(null);
                try {
                  await discover.mutateAsync({ cidr: selected });
                } catch (caught) {
                  setError(caught instanceof ApiError ? caught.message : String(caught));
                }
              }}
            >
              Scan {selected}
            </Button>
          </div>

          {error && <Banner tone="bad">{error}</Banner>}

          {discover.data && (
            <div>
              <p className="text-xs text-[var(--color-ink-faint)]">
                Scanned {discover.data.scanned} addresses, found {discover.data.found.length}.
              </p>
              <ul className="mt-2 grid gap-1">
                {discover.data.found.map((found) => (
                  <li key={found.host}>
                    <button
                      type="button"
                      onClick={() => onPick(found.host)}
                      className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] p-2 text-left text-sm hover:bg-[var(--color-surface-3)]"
                    >
                      <span className="font-medium text-[var(--color-ink)]">{found.host}</span>
                      <span className="ml-2 text-xs text-[var(--color-ink-faint)]">
                        {profileLabel(found.profileId)}
                        {found.modelName ? ` · ${found.modelName}` : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
