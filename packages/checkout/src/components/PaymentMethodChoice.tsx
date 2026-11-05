import type { FaircoinUnavailableReason } from '@peable.to/shared-types';
import { useI18n } from '../i18n';

export type PayerMethod = 'card' | 'faircoin';

/** FairCoin's availability as an order reports it (ADR 0021); `null` when nothing is paid. */
export interface FaircoinAvailability {
  readonly available: boolean;
  readonly unavailable_reason: FaircoinUnavailableReason | null;
}

/** Why FairCoin cannot be chosen, in the payer's words — or `null` when it can. */
export function useFaircoinUnavailableText(
  faircoin: FaircoinAvailability | null | undefined,
): string | null {
  const { t } = useI18n();
  if (!faircoin || faircoin.available) return null;
  switch (faircoin.unavailable_reason) {
    case 'faircoin_wallet_missing':
      return t('faircoinUnavailableWallet');
    case 'faircoin_network_closed':
      return t('faircoinUnavailableNetwork');
    case 'temporarily_unavailable':
      return t('faircoinUnavailableTemporary');
    default:
      return t('faircoinUnavailablePrice');
  }
}

/**
 * How the payer pays an order: its card methods or FairCoin. FairCoin is
 * ALWAYS shown (ADR 0021) — when it cannot be paid with right now, it is shown
 * disabled with the reason, never hidden.
 */
export function PaymentMethodChoice({
  methods,
  value,
  faircoin,
  disabled = false,
  onChange,
}: {
  methods: readonly PayerMethod[];
  value: PayerMethod;
  faircoin: FaircoinAvailability | null | undefined;
  disabled?: boolean;
  onChange: (method: PayerMethod) => void;
}) {
  const { t } = useI18n();
  const unavailable = useFaircoinUnavailableText(faircoin);
  if (methods.length < 2 && unavailable === null) return null;
  return (
    <fieldset className="payment-method-choice" disabled={disabled}>
      <legend className="section-heading">{t('paymentMethod')}</legend>
      {methods.map((method) => {
        const blocked = method === 'faircoin' && unavailable !== null;
        return (
          <label
            key={method}
            className={`payment-method-choice__option${blocked ? ' payment-method-choice__option--disabled' : ''}`}
          >
            <input
              type="radio"
              name="payment_method_type"
              value={method}
              checked={value === method}
              disabled={blocked}
              onChange={() => onChange(method)}
            />
            <span>{method === 'card' ? t('methodCard') : t('methodFaircoin')}</span>
          </label>
        );
      })}
      {unavailable ? <p className="checkout-hint">{unavailable}</p> : null}
    </fieldset>
  );
}
