import type { RequestLogMethod, RequestLogStatusFilter } from '@peable.to/shared-types';
import type { StatusTone } from '../payments/status';

/**
 * Developers › Logs: the merchant's own API requests (`req_…`).
 *
 * The methods are restated from `REQUEST_LOG_METHODS` (the shared-types root
 * barrel cannot load in a browser) and pinned to it by `requestLogs.test.ts`.
 */
export const ORBIT_REQUEST_LOG_METHODS: readonly RequestLogMethod[] = [
  'GET',
  'POST',
  'DELETE',
  'PATCH',
  'PUT',
];

/** The status classes the filter offers; the gateway also takes one exact code. */
export const ORBIT_STATUS_CLASSES = [
  '2xx',
  '4xx',
  '5xx',
] as const satisfies readonly RequestLogStatusFilter[];

/** Success green, a refusal amber, a failure red. */
export function requestStatusTone(status: number): StatusTone {
  if (status >= 500) return 'danger';
  if (status >= 400) return 'warning';
  if (status >= 200 && status < 300) return 'success';
  return 'neutral';
}

/** A request's duration, in milliseconds below a second and seconds above. */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** Where a request's log lives in Orbit — what a payment's events link to. */
export const requestLogPath = (requestId: string) =>
  `/developers/logs/${encodeURIComponent(requestId)}`;

/** Where an event lives in Orbit. */
export const eventPath = (eventId: string) => `/developers/events/${encodeURIComponent(eventId)}`;

/**
 * An event `type` filter as typed: an exact dotted name, or a prefix ending in
 * `.*` — the gateway's own pattern. Empty is no filter; anything else is
 * refused here rather than sent to be refused.
 */
export function parseEventTypeFilter(text: string): { ok: true; type?: string } | { ok: false } {
  const value = text.trim();
  if (!value || value === '*') return { ok: true };
  return /^[a-z_]+(\.[a-z_]+)*(\.\*)?$/.test(value) && value.length <= 100
    ? { ok: true, type: value }
    : { ok: false };
}
