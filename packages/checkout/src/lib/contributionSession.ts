import { contributionAmountSchema, contributionOperationKeySchema } from '@peable.to/contracts';
interface Operation {
  key: string;
  amount: string;
}
const storageKey = (linkId: string) => `peable:contribution:${linkId}`;
/** Written BEFORE the network call. An unknown response never rotates the operation. */
export function getContributionOperation(linkId: string): Operation | null {
  const raw = sessionStorage.getItem(storageKey(linkId));
  if (!raw) return null;
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || !('key' in parsed) || !('amount' in parsed))
    throw new Error('Stored contribution is invalid; use its receipt before starting another');
  return {
    key: contributionOperationKeySchema.parse(parsed.key),
    amount: contributionAmountSchema.parse(parsed.amount),
  };
}
export function beginContribution(linkId: string, amount: string): Operation {
  const prior = getContributionOperation(linkId);
  if (prior) return prior;
  const operation = { key: crypto.randomUUID(), amount: contributionAmountSchema.parse(amount) };
  sessionStorage.setItem(storageKey(linkId), JSON.stringify(operation));
  return operation;
}
