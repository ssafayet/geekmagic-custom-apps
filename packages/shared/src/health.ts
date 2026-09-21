export const HEALTH_STATUSES = ['unknown', 'healthy', 'degraded', 'error', 'disabled'] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export interface HealthReport {
  status: HealthStatus;
  message?: string;
  code?: string;
  lastSuccessAt?: string | null;
  details?: Record<string, unknown>;
}
