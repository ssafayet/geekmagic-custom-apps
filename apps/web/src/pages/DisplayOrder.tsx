import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../api/client.js';
import {
  useDevices,
  useModuleDefinitions,
  useModuleInstances,
  usePlaylist,
  useSavePlaylist,
  useSettings,
} from '../api/hooks.js';
import {
  Banner,
  Button,
  Card,
  EmptyState,
  Spinner4,
  Switch,
  inputClass,
} from '../components/ui.js';
import { Preview } from '../components/Preview.js';

interface DraftItem {
  key: string;
  moduleInstanceId: string;
  viewId: string;
  dwellSeconds: number;
  enabled: boolean;
}

export function DisplayOrderPage() {
  const devices = useDevices();
  const [deviceId, setDeviceId] = useState<string | null>(null);

  if (devices.isLoading) return <Spinner4 />;
  const list = devices.data ?? [];
  if (list.length === 0) {
    return <EmptyState title="No displays configured">Add a display first.</EmptyState>;
  }

  const selected = deviceId ?? list[0]?.id ?? '';

  return (
    <div className="grid gap-5">
      {list.length > 1 && (
        <Card title="Display">
          <select
            aria-label="Display"
            className={inputClass}
            value={selected}
            onChange={(event) => setDeviceId(event.target.value)}
          >
            {list.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
              </option>
            ))}
          </select>
        </Card>
      )}
      <PlaylistEditor key={selected} deviceId={selected} />
    </div>
  );
}

export function PlaylistEditor({
  deviceId,
  onDirtyChange,
}: {
  deviceId: string;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const playlist = usePlaylist(deviceId);
  const instances = useModuleInstances();
  const definitions = useModuleDefinitions();
  const settings = useSettings();
  const save = useSavePlaylist(deviceId);

  const [items, setItems] = useState<DraftItem[]>([]);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  useEffect(() => {
    if (!playlist.data) return;
    setItems(
      playlist.data.map((item) => ({
        key: item.id,
        moduleInstanceId: item.moduleInstanceId,
        viewId: item.viewId,
        dwellSeconds: item.dwellSeconds,
        enabled: item.enabled,
      })),
    );
  }, [playlist.data]);

  /** Only views a module marks selectable can be scheduled in rotation. */
  const available = useMemo(() => {
    const out: Array<{ moduleInstanceId: string; viewId: string; label: string }> = [];
    for (const instance of instances.data ?? []) {
      const definition = definitions.data?.find((candidate) => candidate.id === instance.moduleId);
      for (const view of definition?.views ?? []) {
        if (!view.selectable) continue;
        out.push({
          moduleInstanceId: instance.id,
          viewId: view.id,
          label: `${instance.name} · ${view.displayName}`,
        });
      }
    }
    return out;
  }, [instances.data, definitions.data]);

  const unused = available.filter(
    (candidate) =>
      !items.some(
        (item) =>
          item.moduleInstanceId === candidate.moduleInstanceId && item.viewId === candidate.viewId,
      ),
  );

  const dirty = useMemo(() => {
    const original = (playlist.data ?? []).map(
      (item) => `${item.moduleInstanceId}:${item.viewId}:${item.dwellSeconds}:${item.enabled}`,
    );
    const current = items.map(
      (item) => `${item.moduleInstanceId}:${item.viewId}:${item.dwellSeconds}:${item.enabled}`,
    );
    return JSON.stringify(original) !== JSON.stringify(current);
  }, [items, playlist.data]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty]);

  if (playlist.isLoading || instances.isLoading || definitions.isLoading) return <Spinner4 />;

  const move = (index: number, delta: number) => {
    setItems((current) => {
      const next = [...current];
      const target = index + delta;
      if (target < 0 || target >= next.length) return current;
      const [moved] = next.splice(index, 1);
      if (moved) next.splice(target, 0, moved);
      return next;
    });
  };

  const persist = async () => {
    setNotice(null);
    try {
      await save.mutateAsync({
        items: items.map((item) => ({
          moduleInstanceId: item.moduleInstanceId,
          viewId: item.viewId,
          dwellSeconds: item.dwellSeconds,
          enabled: item.enabled,
        })),
      });
      setNotice({ tone: 'ok', text: 'Display order saved.' });
    } catch (caught) {
      setNotice({
        tone: 'bad',
        text: caught instanceof ApiError ? caught.message : String(caught),
      });
    }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto]">
      <Card
        title="Display order"
        description="Frames rotate in this order. An ADS-B overhead alert can interrupt the rotation and then hand it back."
        actions={
          <>
            {dirty && (
              <span className="self-center text-xs text-[var(--color-warn)]">Unsaved changes</span>
            )}
            <Button
              variant="primary"
              disabled={!dirty}
              busy={save.isPending}
              onClick={() => void persist()}
            >
              Save order
            </Button>
          </>
        }
      >
        {notice && (
          <div className="mb-4">
            <Banner tone={notice.tone === 'ok' ? 'ok' : 'bad'}>{notice.text}</Banner>
          </div>
        )}

        {items.length === 0 ? (
          <EmptyState title="Nothing scheduled">
            Add a module view below to start showing something on this display.
          </EmptyState>
        ) : (
          <ol className="grid gap-2">
            {items.map((item, index) => {
              const label =
                available.find(
                  (candidate) =>
                    candidate.moduleInstanceId === item.moduleInstanceId &&
                    candidate.viewId === item.viewId,
                )?.label ?? `${item.moduleInstanceId} · ${item.viewId}`;

              return (
                <li
                  key={item.key}
                  className="grid gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] p-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center"
                >
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      aria-label={`Move ${label} earlier`}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      ↑
                    </Button>
                    <Button
                      variant="ghost"
                      aria-label={`Move ${label} later`}
                      disabled={index === items.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      ↓
                    </Button>
                    <span className="w-6 text-center text-xs tabular-nums text-[var(--color-ink-faint)]">
                      {index + 1}
                    </span>
                  </div>

                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-[var(--color-ink)]">{label}</p>
                    <div className="mt-1 flex items-center gap-2">
                      <label
                        htmlFor={`dwell-${item.key}`}
                        className="text-xs text-[var(--color-ink-faint)]"
                      >
                        Show for
                      </label>
                      <input
                        id={`dwell-${item.key}`}
                        type="number"
                        min={5}
                        max={3600}
                        className={`${inputClass} w-24 py-1`}
                        value={item.dwellSeconds}
                        onChange={(event) =>
                          setItems((current) =>
                            current.map((candidate, candidateIndex) =>
                              candidateIndex === index
                                ? { ...candidate, dwellSeconds: Number(event.target.value) }
                                : candidate,
                            ),
                          )
                        }
                      />
                      <span className="text-xs text-[var(--color-ink-faint)]">seconds</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <Switch
                      label={`${label} enabled`}
                      checked={item.enabled}
                      onChange={(value) =>
                        setItems((current) =>
                          current.map((candidate, candidateIndex) =>
                            candidateIndex === index ? { ...candidate, enabled: value } : candidate,
                          ),
                        )
                      }
                    />
                    <Button
                      variant="ghost"
                      aria-label={`Remove ${label}`}
                      onClick={() => setItems((current) => current.filter((_, i) => i !== index))}
                    >
                      Remove
                    </Button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        {unused.length > 0 && (
          <div className="mt-4 border-t border-[var(--color-line)] pt-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
              Add to the rotation
            </p>
            <div className="flex flex-wrap gap-2">
              {unused.map((candidate) => (
                <Button
                  key={`${candidate.moduleInstanceId}:${candidate.viewId}`}
                  onClick={() =>
                    setItems((current) => [
                      ...current,
                      {
                        key: `new-${candidate.moduleInstanceId}-${candidate.viewId}-${current.length}`,
                        moduleInstanceId: candidate.moduleInstanceId,
                        viewId: candidate.viewId,
                        dwellSeconds: settings.data?.defaultDwellSeconds ?? 20,
                        enabled: true,
                      },
                    ])
                  }
                >
                  + {candidate.label}
                </Button>
              ))}
            </div>
            <p className="mt-2 text-xs text-[var(--color-ink-faint)]">
              Interrupt-only views are not listed: a module raises those itself.
            </p>
          </div>
        )}
      </Card>

      <Card title="Preview" className="lg:w-[320px]">
        <Preview
          path={`/devices/${deviceId}/preview`}
          label="Current frame"
          size={240}
          refreshMs={8_000}
        />
      </Card>
    </div>
  );
}
