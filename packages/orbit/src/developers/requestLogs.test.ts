import { describe, expect, it } from 'bun:test';
import { REQUEST_LOG_METHODS } from '@peable.to/shared-types';
import {
  eventPath,
  formatDuration,
  ORBIT_REQUEST_LOG_METHODS,
  parseEventTypeFilter,
  requestLogPath,
  requestStatusTone,
} from './requestLogs';

describe('request logs', () => {
  it('restates the methods the gateway logs', () => {
    expect([...ORBIT_REQUEST_LOG_METHODS]).toEqual([...REQUEST_LOG_METHODS]);
  });

  it('paints a status by its class', () => {
    expect([200, 201, 302, 404, 409, 500, 503].map(requestStatusTone)).toEqual([
      'success',
      'success',
      'neutral',
      'warning',
      'warning',
      'danger',
      'danger',
    ]);
  });

  it('formats a duration for a person', () => {
    expect(formatDuration(42.4)).toBe('42 ms');
    expect(formatDuration(1520)).toBe('1.52 s');
  });

  it('links a request and an event to their pages', () => {
    expect(requestLogPath('req_ab12')).toBe('/developers/logs/req_ab12');
    expect(eventPath('evt_1')).toBe('/developers/events/evt_1');
  });
});

describe('parseEventTypeFilter', () => {
  it('takes an exact type or a prefix, and nothing for empty or *', () => {
    expect(parseEventTypeFilter(' payment_intent.succeeded ')).toEqual({
      ok: true,
      type: 'payment_intent.succeeded',
    });
    expect(parseEventTypeFilter('charge.dispute.*')).toEqual({
      ok: true,
      type: 'charge.dispute.*',
    });
    expect(parseEventTypeFilter('')).toEqual({ ok: true });
    expect(parseEventTypeFilter('*')).toEqual({ ok: true });
  });

  it('refuses what the gateway would', () => {
    expect(parseEventTypeFilter('Payment Intent')).toEqual({ ok: false });
    expect(parseEventTypeFilter('payment_intent.%')).toEqual({ ok: false });
  });
});
