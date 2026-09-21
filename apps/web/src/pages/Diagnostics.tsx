import { useState } from 'react';
import { apiRequest } from '../api/client.js';
import { useHealth } from '../api/hooks.js';
import { Banner, Button, Card, Kv, Spinner4 } from '../components/ui.js';
import { absoluteTime, relativeTime } from '../format.js';

export function DiagnosticsPage() {
  const health = useHealth();
  const [report, setReport] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await apiRequest<Record<string, unknown>>('/diagnostics'));
    } catch (caught) {
      setError(String(caught));
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `gca-diagnostics-${new Date().toISOString().slice(0, 19).replace(/[:]/g, '')}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  if (health.isLoading) return <Spinner4 />;

  return (
    <div className="grid gap-5">
      <Card title="Runtime">
        <dl className="grid gap-x-8 sm:grid-cols-2">
          <Kv label="Version" value={health.data?.version ?? '—'} />
          <Kv label="Started" value={absoluteTime(health.data?.startedAt)} />
          <Kv label="Displays" value={String(health.data?.devices ?? 0)} />
          <Kv
            label="Claude bridge"
            value={
              health.data?.bridge.connected
                ? `last payload ${relativeTime(health.data.bridge.lastReceivedAt)}`
                : 'no payload received'
            }
            tone={health.data?.bridge.connected ? 'good' : 'warn'}
          />
        </dl>
      </Card>

      <Card
        title="Diagnostic report"
        description="Preview exactly what would be shared before you download it."
        actions={
          <>
            <Button busy={busy} onClick={() => void load()}>
              Generate
            </Button>
            <Button variant="primary" disabled={!report} onClick={download}>
              Download JSON
            </Button>
          </>
        }
      >
        <Banner tone="info" title="What this excludes">
          Hostnames, ADS-B coordinates, credentials and album backups are left out. Everything
          included is shown below before you download anything.
        </Banner>

        {error && (
          <div className="mt-3">
            <Banner tone="bad">{error}</Banner>
          </div>
        )}

        {report && (
          <pre className="mt-3 max-h-[28rem] overflow-auto rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] p-3 text-xs leading-relaxed text-[var(--color-ink-muted)]">
            {JSON.stringify(report, null, 2)}
          </pre>
        )}
      </Card>

      <Card title="Unsupported firmware">
        <p className="text-sm text-[var(--color-ink-muted)]">
          If a display was detected as unrecognised, generate the report above and attach it to an
          issue. It contains the probe transcript, model string and firmware version but no network
          identifiers, which is enough to add an adapter.
        </p>
      </Card>
    </div>
  );
}
