import { describe, expect, test } from 'bun:test';
import {
  availableOrderReward,
  matchingRewardOffers,
  selectedRewardCategories,
  type PeableOrderReward,
} from '../orderRewards';
const reward: PeableOrderReward = {
  orderId: 'order-1',
  eligible: true,
  title: 'Gift',
  description: 'Optional',
  expiresAt: '2027-01-01T00:00:00Z',
  deadlineLabel: 'January 1',
  minimumCategories: 2,
  categories: [
    { id: 'art', label: 'Art' },
    { id: 'books', label: 'Books' },
    { id: 'music', label: 'Music' },
  ],
  offers: [
    {
      id: 'gift-art',
      title: 'Art',
      description: 'Description',
      categoryIds: ['art'],
      terms: ['One gift'],
    },
    {
      id: 'gift-music',
      title: 'Music',
      description: 'Description',
      categoryIds: ['music'],
      terms: ['One gift'],
    },
  ],
  terms: ['Optional'],
};
describe('host-supplied order rewards', () => {
  test('requires exact order binding, eligibility and unexpired deadline', () => {
    const now = Date.parse('2026-11-03T00:00:00Z');
    expect(availableOrderReward('order-1', reward, now)).toBe(true);
    expect(availableOrderReward('other', reward, now)).toBe(false);
    expect(availableOrderReward('order-1', { ...reward, eligible: false }, now)).toBe(false);
    expect(availableOrderReward('order-1', reward, Date.parse(reward.expiresAt))).toBe(false);
    expect(availableOrderReward('order-1', { ...reward, expiresAt: 'invalid' }, now)).toBe(false);
    expect(availableOrderReward('order-1', { ...reward, minimumCategories: 4 }, now)).toBe(false);
  });
  test('unknown or repeated categories cannot satisfy minimum selection', () => {
    expect(selectedRewardCategories(reward, ['art', 'art', 'invented'])).toEqual(['art']);
    expect(matchingRewardOffers(reward, ['art', 'art', 'invented'])).toEqual([]);
  });
  test('only supplied matching offers become choices, without mutating the order or reward', () => {
    const before = JSON.stringify(reward);
    expect(matchingRewardOffers(reward, ['art', 'books']).map((item) => item.id)).toEqual([
      'gift-art',
    ]);
    expect(matchingRewardOffers(reward, ['art', 'music']).map((item) => item.id)).toEqual([
      'gift-art',
      'gift-music',
    ]);
    expect(JSON.stringify(reward)).toBe(before);
  });
});
