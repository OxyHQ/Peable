import type { ReactNode } from 'react';

export type OrderRewardScreen = 'order' | 'reward' | 'categories' | 'offers' | 'offer' | 'claimed';
export interface PeableOrderDetails {
  id: string;
  merchant: string;
  placedOn: string;
  currency: string;
  totalMinorUnits: number;
  paidMinorUnits: number;
  remainingMinorUnits: number;
  items: readonly { id: string; name: string; detail?: string; artwork?: ReactNode }[];
  payments: readonly {
    id: string;
    date: string;
    amountMinorUnits: number;
    status: 'paid' | 'scheduled';
    method?: string;
  }[];
}
export interface PeableRewardOffer {
  id: string;
  title: string;
  description: string;
  artwork?: ReactNode;
  categoryIds: readonly string[];
  terms: readonly string[];
}
export interface PeableOrderReward {
  orderId: string;
  eligible: boolean;
  title: string;
  description: string;
  expiresAt: string;
  deadlineLabel: string;
  minimumCategories: number;
  categories: readonly { id: string; label: string }[];
  offers: readonly PeableRewardOffer[];
  terms: readonly string[];
}
/** Eligibility supplied by a trusted host; this structural check grants nothing. */
export function availableOrderReward(
  orderId: string,
  reward: PeableOrderReward | undefined,
  now: number,
): reward is PeableOrderReward {
  return (
    !!reward &&
    reward.eligible &&
    reward.orderId === orderId &&
    Number.isFinite(Date.parse(reward.expiresAt)) &&
    Date.parse(reward.expiresAt) > now &&
    Number.isSafeInteger(reward.minimumCategories) &&
    reward.minimumCategories > 0 &&
    reward.minimumCategories <= reward.categories.length
  );
}
export function selectedRewardCategories(
  reward: PeableOrderReward,
  selected: readonly string[],
): string[] {
  const allowed = new Set(reward.categories.map((item) => item.id));
  return [...new Set(selected)].filter((id) => allowed.has(id));
}
export function matchingRewardOffers(
  reward: PeableOrderReward,
  selected: readonly string[],
): readonly PeableRewardOffer[] {
  const ids = selectedRewardCategories(reward, selected);
  if (ids.length < reward.minimumCategories) return [];
  return reward.offers.filter((offer) => offer.categoryIds.some((id) => ids.includes(id)));
}
