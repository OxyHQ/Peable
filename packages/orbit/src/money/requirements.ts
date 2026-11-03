import type { AccountRequirements } from '@peable.to/shared-types';
import { t } from '../i18n';

/**
 * Requirement IDENTIFIERS (`individual.verification.document`) in a person's
 * words. The gateway forwards the provider's identifiers and never their
 * values; this is presentation only and decides nothing.
 */

/** The groups a screen shows, most urgent first. `disabled_reason` is shown apart. */
export const REQUIREMENT_GROUPS = [
  'past_due',
  'currently_due',
  'eventually_due',
  'pending_verification',
] as const satisfies readonly (keyof AccountRequirements)[];

export type RequirementGroup = (typeof REQUIREMENT_GROUPS)[number];

/** Parts of a date or an address that are one thing to a person. */
const COLLAPSED_LEAVES = new Set(['dob', 'address']);

/**
 * The catalog key an identifier is worded by: the longest known prefix, with
 * the parts of a date or an address folded into the whole
 * (`individual.dob.day` → `individual.dob`) and a provider person id read as
 * "a person" (`person_1A2b.first_name` → `person`).
 */
function catalogKeyCandidates(id: string): string[] {
  const parts = id.split('.');
  if (parts[0]?.startsWith('person_')) parts[0] = 'person';
  const collapse = parts.findIndex((part) => COLLAPSED_LEAVES.has(part));
  const kept = collapse === -1 ? parts : parts.slice(0, collapse + 1);
  const candidates: string[] = [];
  for (let length = kept.length; length > 0; length -= 1) {
    candidates.push(`requirement.${kept.slice(0, length).join('.')}`);
  }
  return candidates;
}

/** `company.tax_id` → `Company › tax id`, for an identifier the catalog does not word. */
export function humanizeRequirement(id: string): string {
  const words = id
    .split('.')
    .map((part) => (part.startsWith('person_') ? 'person' : part).replace(/_/g, ' '))
    .filter((part) => part.length > 0);
  const [first, ...rest] = words;
  if (first === undefined) return id;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' › ');
}

/** One identifier in words. */
export function requirementLabel(id: string): string {
  for (const key of catalogKeyCandidates(id)) {
    const label = t(key);
    if (label !== key) return label;
  }
  return humanizeRequirement(id);
}

/** A group's identifiers in words, each said once (`dob.day` and `dob.month` are one date). */
export function requirementLabels(ids: readonly string[]): string[] {
  return [...new Set(ids.map(requirementLabel))];
}

/** The provider's `disabled_reason` in words, or `null` when nothing is disabled. */
export function disabledReasonLabel(reason: string | null): string | null {
  if (reason === null) return null;
  const key = `disabledReason.${reason}`;
  const label = t(key);
  return label === key ? humanizeRequirement(reason) : label;
}

/** Whether the provider is waiting on nothing at all. */
export function requirementsClear(requirements: AccountRequirements): boolean {
  return (
    requirements.disabled_reason === null &&
    REQUIREMENT_GROUPS.every((group) => requirements[group].length === 0)
  );
}

export type OnboardingAction = 'start' | 'resume' | 'update';

/**
 * What the onboarding button says. `start` before the provider ever enabled
 * anything with information still owed; `resume` while something is owed;
 * `update` once nothing is — the same hosted page, to change what was sent.
 */
export function onboardingAction(account: {
  charges_enabled: boolean;
  payouts_enabled: boolean;
  requirements: AccountRequirements;
}): OnboardingAction {
  const owed =
    account.requirements.currently_due.length > 0 ||
    account.requirements.past_due.length > 0 ||
    account.requirements.eventually_due.length > 0;
  if (!owed && account.charges_enabled && account.payouts_enabled) return 'update';
  if (!account.charges_enabled && !account.payouts_enabled && owed) {
    return account.requirements.pending_verification.length > 0 ? 'resume' : 'start';
  }
  return 'resume';
}
