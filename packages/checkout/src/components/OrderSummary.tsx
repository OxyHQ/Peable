import { useEffect, useId, useRef, useState } from 'react';
import type { CheckoutLineItem, CheckoutSessionPublic } from '@peable.to/shared-types';
import { useI18n } from '../i18n';
import { formatAmount, isZero } from '../lib/money';

/** How long a quantity edit waits for the payer to stop clicking before it is sent. */
export const QUANTITY_DEBOUNCE_MS = 400;

const DEFAULT_MINIMUM = 0;
const DEFAULT_MAXIMUM = 99;

function QuantityStepper({
  item,
  disabled,
  error,
  onCommit,
}: {
  item: CheckoutLineItem;
  disabled: boolean;
  error: string | null;
  onCommit: (quantity: number) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const minimum = item.adjustable_quantity?.minimum ?? DEFAULT_MINIMUM;
  const maximum = item.adjustable_quantity?.maximum ?? DEFAULT_MAXIMUM;
  const [value, setValue] = useState(item.quantity);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The gateway's quantity wins whenever it answers (a refused edit snaps back).
  useEffect(() => {
    setValue(item.quantity);
  }, [item.quantity]);
  useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current);
    },
    [],
  );

  function schedule(next: number) {
    const clamped = Math.min(maximum, Math.max(minimum, next));
    setValue(clamped);
    if (pending.current) clearTimeout(pending.current);
    if (clamped === item.quantity) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      onCommit(clamped);
    }, QUANTITY_DEBOUNCE_MS);
  }

  return (
    <div className="quantity">
      <button
        type="button"
        className="quantity__step"
        aria-label={t('decrease', { item: item.description })}
        disabled={disabled || value <= minimum}
        onClick={() => schedule(value - 1)}
      >
        −
      </button>
      <label className="visually-hidden" htmlFor={id}>
        {t('quantityFor', { item: item.description })}
      </label>
      <input
        id={id}
        className="quantity__input"
        type="number"
        inputMode="numeric"
        min={minimum}
        max={maximum}
        value={value}
        disabled={disabled}
        aria-invalid={error !== null}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => {
          const parsed = Number.parseInt(event.target.value, 10);
          if (Number.isSafeInteger(parsed)) schedule(parsed);
        }}
      />
      <button
        type="button"
        className="quantity__step"
        aria-label={t('increase', { item: item.description })}
        disabled={disabled || value >= maximum}
        onClick={() => schedule(value + 1)}
      >
        +
      </button>
      {error && (
        <p id={`${id}-error`} className="field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function PromotionCode({
  session,
  editable,
  error,
  onApply,
}: {
  session: CheckoutSessionPublic;
  editable: boolean;
  error: string | null;
  onApply: (code: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const id = useId();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const applied = session.discount?.promotion_code ?? null;

  async function apply(value: string) {
    setBusy(true);
    try {
      await onApply(value);
      if (value !== '') setCode('');
    } finally {
      setBusy(false);
    }
  }

  if (applied) {
    return (
      <div className="promo promo--applied">
        <span className="promo__code">{applied}</span>
        {editable && (
          <button
            type="button"
            className="link-button"
            disabled={busy}
            onClick={() => {
              void apply('');
            }}
          >
            {t('promoRemove')}
          </button>
        )}
      </div>
    );
  }
  if (!editable || !session.allow_promotion_codes) return null;
  return (
    <form
      className="promo"
      onSubmit={(event) => {
        event.preventDefault();
        if (code.trim()) void apply(code.trim());
      }}
    >
      <label htmlFor={id}>{t('promoLabel')}</label>
      <div className="promo__row">
        <input
          id={id}
          value={code}
          autoComplete="off"
          aria-invalid={error !== null}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => setCode(event.target.value)}
        />
        <button type="submit" className="secondary-button" disabled={busy || !code.trim()}>
          {t('promoApply')}
        </button>
      </div>
      {error && (
        <p id={`${id}-error`} className="field__error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/**
 * The order: lines, quantities, discount, tax and the total due — every
 * figure the gateway's. `editable` is false once the payment exists: the
 * order is then locked, and this shows it as it was confirmed.
 */
export function OrderSummary({
  session,
  editable,
  errors,
  onQuantity,
  onPromotionCode,
}: {
  session: CheckoutSessionPublic;
  editable: boolean;
  /** Field errors, keyed by `line:<id>` for a line and `promotion_code` for the code. */
  errors: Readonly<Record<string, string>>;
  onQuantity: (lineId: string, quantity: number) => void;
  onPromotionCode: (code: string) => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const money = (amount: string) => formatAmount(amount, session.currency, locale);
  const details = session.total_details;
  const discountLabel = session.discount?.promotion_code
    ? t('discountCode', { code: session.discount.promotion_code })
    : session.discount?.coupon_name
      ? t('discountCode', { code: session.discount.coupon_name })
      : t('discount');

  return (
    <section className="order-summary" aria-labelledby="order-summary-heading">
      <h2 id="order-summary-heading" className="section-heading">
        {t('orderSummary')}
      </h2>
      <ul className="line-items">
        {session.line_items.map((item) => (
          <li key={item.id} className="line-item">
            {item.images[0] && (
              <img className="line-item__image" src={item.images[0]} alt="" loading="lazy" />
            )}
            <div className="line-item__body">
              <p className="line-item__name">{item.description}</p>
              {item.unit_amount !== null && item.quantity !== 1 && (
                <p className="line-item__unit">{t('each', { amount: money(item.unit_amount) })}</p>
              )}
              {editable && item.adjustable_quantity?.enabled ? (
                <QuantityStepper
                  item={item}
                  disabled={false}
                  error={errors[`line:${item.id}`] ?? null}
                  onCommit={(quantity) => onQuantity(item.id, quantity)}
                />
              ) : (
                <p className="line-item__qty">{t('qty', { quantity: item.quantity })}</p>
              )}
            </div>
            <p className="line-item__amount">{money(item.amount_subtotal)}</p>
          </li>
        ))}
      </ul>

      <PromotionCode
        session={session}
        editable={editable}
        error={errors.promotion_code ?? null}
        onApply={onPromotionCode}
      />

      <dl className="totals" aria-live="polite">
        <div className="totals__row">
          <dt>{t('subtotal')}</dt>
          <dd>{money(session.amount_subtotal)}</dd>
        </div>
        {!isZero(details.amount_discount) && (
          <div className="totals__row">
            <dt>{discountLabel}</dt>
            <dd>−{money(details.amount_discount)}</dd>
          </div>
        )}
        {!isZero(details.amount_shipping) && (
          <div className="totals__row">
            <dt>{t('shipping')}</dt>
            <dd>{money(details.amount_shipping)}</dd>
          </div>
        )}
        {(session.automatic_tax.enabled || !isZero(details.amount_tax)) && (
          <div className="totals__row">
            <dt>{t('tax')}</dt>
            <dd>{money(details.amount_tax)}</dd>
          </div>
        )}
        <div className="totals__row totals__row--total">
          <dt>{t('total')}</dt>
          <dd data-testid="amount-total">{money(session.amount_total)}</dd>
        </div>
      </dl>
    </section>
  );
}
