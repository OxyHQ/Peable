import { describe, expect, it } from 'bun:test';
import { PAYMENT_INTENT_STATUSES } from '@peable.to/shared-types';
import {
  deliveryStatusLabel,
  deliveryStatusTone,
  ORBIT_PAYMENT_STATUSES,
  paymentStatusLabel,
  paymentStatusTone,
} from './status';

describe('ORBIT_PAYMENT_STATUSES', () => {
  it('is every gateway status, each exactly once', () => {
    expect([...ORBIT_PAYMENT_STATUSES].sort()).toEqual([...PAYMENT_INTENT_STATUSES].sort());
  });

  it('labels and paints every status', () => {
    for (const status of PAYMENT_INTENT_STATUSES) {
      expect(paymentStatusLabel(status)).not.toBe(status);
      expect(paymentStatusTone(status)).toBeDefined();
    }
  });
});

describe('payment tones', () => {
  it('reads success, failure and waiting apart', () => {
    expect(paymentStatusTone('settled')).toBe('success');
    expect(paymentStatusTone('failed')).toBe('danger');
    expect(paymentStatusTone('requires_action')).toBe('warning');
  });
});

describe('delivery statuses', () => {
  it('says what each outcome means to the merchant', () => {
    expect(deliveryStatusLabel('failed')).toBe('Refused');
    expect(deliveryStatusLabel('dead')).toBe('Gave up');
    expect(deliveryStatusTone('delivered')).toBe('success');
    expect(deliveryStatusTone('pending')).toBe('info');
  });
});
