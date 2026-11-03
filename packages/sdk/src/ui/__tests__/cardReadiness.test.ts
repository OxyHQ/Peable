import { expect, test } from 'bun:test';
import { matchingCardAction } from '../cardReadiness';
import type { PeableClientAction } from '../../browser/payerClient';
const action: PeableClientAction = {
  object: 'client_action',
  kind: 'client_secret',
  value: 'payer-authority',
  publishable_key: 'pk_test_example',
};
test('public card configuration alone never authorizes preparation', () => {
  expect(matchingCardAction(undefined, action.publishable_key)).toBeUndefined();
  expect(matchingCardAction(action, undefined)).toBeUndefined();
  expect(matchingCardAction({ ...action, value: '' }, action.publishable_key)).toBeUndefined();
});
test('redirects and authority for another provider configuration fail closed', () => {
  expect(
    matchingCardAction({ ...action, kind: 'redirect' }, action.publishable_key),
  ).toBeUndefined();
  expect(matchingCardAction(action, 'pk_live_different')).toBeUndefined();
});
test('matching real authority enables preparation without changing public configuration', () => {
  expect(matchingCardAction(action, action.publishable_key)).toBe(action);
});
