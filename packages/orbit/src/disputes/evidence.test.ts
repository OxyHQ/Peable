import { describe, expect, it } from 'bun:test';
import {
  DISPUTE_FILE_EVIDENCE_FIELDS,
  DISPUTE_REASONS,
  DISPUTE_TEXT_EVIDENCE_FIELDS,
  type Dispute,
  FILE_PURPOSE_POLICIES,
} from '@peable.to/shared-types';
import {
  allowedExtensions,
  disputeReasonLabel,
  disputeStatusLabel,
  disputeStatusTone,
  evidenceChanges,
  evidenceFieldLabel,
  evidenceLocked,
  fileRefusal,
  formFromDispute,
  formHasEvidence,
  lockedReason,
  ORBIT_DISPUTE_FILE_FIELDS,
  ORBIT_DISPUTE_REASONS,
  ORBIT_DISPUTE_STATUSES,
  ORBIT_DISPUTE_TEXT_FIELDS,
  ORBIT_FILE_POLICIES,
} from './evidence';

const NOW = 1_800_000_000;

function dispute(overrides: Partial<Dispute> = {}): Dispute {
  return {
    id: 'dp_1',
    object: 'dispute',
    livemode: false,
    amount: '5000',
    currency: 'EUR',
    charge: 'ch_1',
    payment_intent: 'pi_1',
    status: 'needs_response',
    reason: 'fraudulent',
    is_charge_refundable: true,
    evidence_details: {
      due_by: NOW + 86_400,
      has_evidence: false,
      past_due: false,
      submission_count: 0,
      submitted_at: null,
    },
    metadata: {},
    created: NOW - 100,
    updated_at: NOW - 100,
    ...overrides,
  };
}

describe('restated vocabulary', () => {
  it('is the gateway’s, field for field', () => {
    expect([...ORBIT_DISPUTE_TEXT_FIELDS].sort()).toEqual([...DISPUTE_TEXT_EVIDENCE_FIELDS].sort());
    expect([...ORBIT_DISPUTE_FILE_FIELDS].sort()).toEqual([...DISPUTE_FILE_EVIDENCE_FIELDS].sort());
    expect([...ORBIT_DISPUTE_REASONS].sort()).toEqual([...DISPUTE_REASONS].sort());
    expect(ORBIT_FILE_POLICIES).toEqual(FILE_PURPOSE_POLICIES);
  });

  it('words every field, status and reason', () => {
    for (const field of [...DISPUTE_TEXT_EVIDENCE_FIELDS, ...DISPUTE_FILE_EVIDENCE_FIELDS]) {
      expect(evidenceFieldLabel(field)).not.toBe(field);
    }
    for (const status of ORBIT_DISPUTE_STATUSES) {
      expect(disputeStatusLabel(status)).not.toBe(status);
    }
    for (const reason of DISPUTE_REASONS) expect(disputeReasonLabel(reason)).not.toBe(reason);
    expect(disputeStatusTone('needs_response')).toBe('warning');
    expect(disputeStatusTone('lost')).toBe('danger');
  });
});

describe('the evidence form', () => {
  it('starts from the gateway’s copy, every unset field empty', () => {
    const form = formFromDispute(
      dispute({
        evidence: {
          ...Object.fromEntries(
            [...DISPUTE_TEXT_EVIDENCE_FIELDS, ...DISPUTE_FILE_EVIDENCE_FIELDS].map((f) => [
              f,
              null,
            ]),
          ),
          uncategorized_text: 'Signed for.',
          receipt: 'file_1',
        } as NonNullable<Dispute['evidence']>,
      }),
    );
    expect(form.uncategorized_text).toBe('Signed for.');
    expect(form.receipt).toBe('file_1');
    expect(form.customer_name).toBe('');
  });

  it('sends only what changed, and an empty string for a cleared field', () => {
    const before = dispute({
      evidence: {
        ...formFromDispute(dispute()),
        uncategorized_text: 'old',
        receipt: 'file_1',
      } as never,
    });
    const form = formFromDispute(before);
    form.uncategorized_text = '';
    form.customer_name = '  Jane  ';
    form.shipping_documentation = 'file_2';
    expect(evidenceChanges(before, form)).toEqual({
      uncategorized_text: '',
      customer_name: 'Jane',
      shipping_documentation: 'file_2',
    });
  });

  it('knows an empty response from a real one', () => {
    const form = formFromDispute(dispute());
    expect(formHasEvidence(form)).toBe(false);
    form.receipt = 'file_1';
    expect(formHasEvidence(form)).toBe(true);
  });
});

describe('when the response is locked', () => {
  it('is open while it needs a response and the deadline is ahead', () => {
    expect(evidenceLocked(dispute(), NOW)).toBe(false);
    expect(lockedReason(dispute(), NOW)).toBeNull();
  });

  it('locks once submitted, closed, under review or past due', () => {
    const submitted = dispute({
      evidence_details: { ...dispute().evidence_details, submission_count: 1, submitted_at: NOW },
    });
    expect(lockedReason(submitted, NOW)).toBe('Your response was submitted.');
    expect(lockedReason(dispute({ status: 'lost' }), NOW)).toBe('This dispute is closed.');
    expect(evidenceLocked(dispute({ status: 'under_review' }), NOW)).toBe(true);
    const late = dispute({ evidence_details: { ...dispute().evidence_details, due_by: NOW - 1 } });
    expect(lockedReason(late, NOW)).toBe('The deadline to respond has passed.');
  });
});

describe('fileRefusal', () => {
  it('offers jpeg beside jpg', () => {
    expect(allowedExtensions('business_logo')).toEqual(['png', 'jpg', 'jpeg']);
  });

  it('refuses a type or a size the purpose does not take', () => {
    expect(fileRefusal({ name: 'r.pdf', size: 10 }, 'dispute_evidence')).toBeNull();
    expect(fileRefusal({ name: 'r.PDF', size: 10 }, 'dispute_evidence')).toBeNull();
    expect(fileRefusal({ name: 'logo.pdf', size: 10 }, 'business_logo')).toContain('PNG, JPG');
    expect(fileRefusal({ name: 'noext', size: 10 }, 'dispute_evidence')).not.toBeNull();
    expect(fileRefusal({ name: 'big.png', size: 600 * 1024 }, 'business_logo')).toBe(
      'That file is larger than 512 KB.',
    );
    expect(fileRefusal({ name: 'big.pdf', size: 6 * 1024 * 1024 }, 'dispute_evidence')).toBe(
      'That file is larger than 5 MB.',
    );
  });
});
