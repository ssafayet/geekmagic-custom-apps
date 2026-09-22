import type { Database } from 'better-sqlite3';
import { newId, nowIso, redactDeep } from '@gca/shared';
import type { AuditEventRecord } from '../types.js';

interface AuditRow {
  id: string;
  event_type: string;
  actor: string;
  entity_type: string;
  entity_id: string | null;
  severity: string;
  details_json: string;
  created_at: string;
  acknowledged_at: string | null;
}

function toRecord(row: AuditRow): AuditEventRecord {
  return {
    id: row.id,
    eventType: row.event_type,
    actor: row.actor,
    entityType: row.entity_type,
    entityId: row.entity_id,
    severity: row.severity as AuditEventRecord['severity'],
    details: JSON.parse(row.details_json) as Record<string, unknown>,
    createdAt: row.created_at,
    acknowledgedAt: row.acknowledged_at,
  };
}

export class AuditRepository {
  constructor(private readonly db: Database) {}

  /** Details are redacted on the way in, so no credential can ever reach an audit row. */
  record(event: {
    eventType: string;
    actor?: string;
    entityType: string;
    entityId?: string | null;
    severity?: AuditEventRecord['severity'];
    details?: Record<string, unknown>;
  }): AuditEventRecord {
    const record: AuditEventRecord = {
      id: newId('aud'),
      eventType: event.eventType,
      actor: event.actor ?? 'system',
      entityType: event.entityType,
      entityId: event.entityId ?? null,
      severity: event.severity ?? 'info',
      details: redactDeep(event.details ?? {}),
      createdAt: nowIso(),
      acknowledgedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO audit_events (id, event_type, actor, entity_type, entity_id, severity, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.eventType,
        record.actor,
        record.entityType,
        record.entityId,
        record.severity,
        JSON.stringify(record.details),
        record.createdAt,
      );
    return record;
  }

  recent(limit = 50): AuditEventRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?')
      .all(limit) as AuditRow[];
    return rows.map(toRecord);
  }

  recentProblems(limit = 10): AuditEventRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM audit_events WHERE severity IN ('warn','error')
           AND acknowledged_at IS NULL
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as AuditRow[];
    return rows.map(toRecord);
  }

  /**
   * Clears problems from the overview without deleting them: the audit log is the
   * record of what happened, so dismissing a banner must not erase the evidence.
   *
   * `ids` narrows the sweep to entries the operator actually saw. Without them every
   * problem raised up to `before` is cleared, so one that arrives mid-click still
   * surfaces rather than being swallowed by a stale list.
   */
  acknowledgeProblems(options: { ids?: string[]; before?: string } = {}): number {
    const at = nowIso();
    const unacknowledged = `acknowledged_at IS NULL AND severity IN ('warn','error')`;

    if (options.ids) {
      if (options.ids.length === 0) return 0;
      const placeholders = options.ids.map(() => '?').join(',');
      return this.db
        .prepare(
          `UPDATE audit_events SET acknowledged_at = ?
           WHERE ${unacknowledged} AND id IN (${placeholders})`,
        )
        .run(at, ...options.ids).changes;
    }

    return this.db
      .prepare(
        `UPDATE audit_events SET acknowledged_at = ?
         WHERE ${unacknowledged} AND created_at <= ?`,
      )
      .run(at, options.before ?? at).changes;
  }

  prune(keep = 2000): number {
    const result = this.db
      .prepare(
        `DELETE FROM audit_events WHERE id NOT IN (
           SELECT id FROM audit_events ORDER BY created_at DESC LIMIT ?
         )`,
      )
      .run(keep);
    return result.changes;
  }
}
