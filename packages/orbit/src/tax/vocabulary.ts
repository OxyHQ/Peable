import type {
  TaxComplianceCapabilityStatus,
  TaxDeadline,
  TaxDocumentChecklistItem,
  TaxObligationOutcome,
  TaxRegistrationDeclarationStatus,
  TaxReviewItem,
} from '@peable.to/shared-types/tax';
import { t } from '../i18n';

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

/**
 * How an outcome reads. Nothing is ever green except a declaration the owner
 * made — and even that is labelled as declared, not as verified.
 */
export function outcomeTone(outcome: TaxObligationOutcome): Tone {
  switch (outcome) {
    case 'likely_required':
      return 'danger';
    case 'uncertain':
    case 'approaching_threshold':
      return 'warning';
    case 'registration_declared':
      return 'info';
    case 'unsupported':
    case 'not_indicated':
      return 'neutral';
  }
}

export const outcomeLabel = (outcome: TaxObligationOutcome) => t(`compliance.outcome.${outcome}`);

export function capabilityTone(status: TaxComplianceCapabilityStatus): Tone {
  if (status === 'available') return 'success';
  if (status === 'limited') return 'warning';
  return 'neutral';
}

export function declarationTone(status: TaxRegistrationDeclarationStatus): Tone {
  switch (status) {
    case 'registered':
      return 'info';
    case 'unknown':
    case 'application_pending':
      return 'warning';
    case 'rejected':
      return 'danger';
    case 'not_registered':
    case 'ended':
      return 'neutral';
  }
}

export function checklistTone(status: TaxDocumentChecklistItem['status']): Tone {
  return status === 'provided' ? 'success' : status === 'missing' ? 'warning' : 'danger';
}

export function reviewTone(item: Pick<TaxReviewItem, 'status' | 'severity'>): Tone {
  if (item.status !== 'open') return 'neutral';
  return item.severity === 'action_required' ? 'danger' : 'warning';
}

export function deadlineTone(status: TaxDeadline['status']): Tone {
  return status === 'due_soon' ? 'warning' : status === 'passed' ? 'neutral' : 'info';
}

/** `US-TX`, `IE`, or the EU as a whole for a rule without a country. */
export function placeLabel(country: string | null, state: string | null): string {
  if (!country) return t('compliance.overview.allJurisdictions');
  return state ? `${country}-${state}` : country;
}

/** `YYYY-MM-DD` as the Unix second of that UTC midnight; `null` for anything else. */
export function parseDay(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const at = Date.parse(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(at) || new Date(at).toISOString().slice(0, 10) !== trimmed) return null;
  return at / 1000;
}

/** A Unix second as its UTC calendar day. */
export function formatDay(seconds: number | null): string {
  return seconds === null ? '—' : new Date(seconds * 1000).toISOString().slice(0, 10);
}

/** An ISO country (`IE`) or subdivision (`TX`) code as typed, or `null` when it is not one. */
export function countryCode(text: string): string | null {
  const code = text.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}
export function stateCode(text: string): string | null {
  const code = text.trim().toUpperCase();
  return /^[A-Z0-9]{1,3}$/.test(code) ? code : null;
}
