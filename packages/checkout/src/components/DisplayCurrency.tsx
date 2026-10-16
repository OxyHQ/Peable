import { useEffect, useId, useState } from 'react';
import {
  convertDisplayAmount,
  DISPLAY_CURRENCIES,
  isDisplayCurrency,
  readDisplayRates,
  type DisplayCurrency as Currency,
  type DisplayRates,
} from '@peable.to/sdk/display';

const STORAGE_KEY = 'peable.displayCurrency';
function savedCurrency(): Currency {
  try {
    const requested = new URLSearchParams(window.location.search).get('displayCurrency');
    if (isDisplayCurrency(requested)) return requested;
    const value = localStorage.getItem(STORAGE_KEY);
    return isDisplayCurrency(value) ? value : 'FAIR';
  } catch {
    return 'FAIR';
  }
}

/** Anonymous display choice. No authentication, payment mutation or stale rate fallback. */
export function DisplayCurrency({ amount }: { amount: string }) {
  const id = useId();
  const [currency, setCurrency] = useState(savedCurrency);
  const [rates, setRates] = useState<DisplayRates | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    async function refresh() {
      try {
        const next = await readDisplayRates({ signal: controller.signal });
        if (active) setRates(next);
      } catch {
        if (active) setRates(null);
      }
    }
    if (currency !== 'FAIR') void refresh();
    const interval = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    const poll = setInterval(() => {
      if (currency !== 'FAIR') void refresh();
    }, 60_000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(interval);
      clearInterval(poll);
    };
  }, [currency]);
  const display = convertDisplayAmount({
    units: amount,
    currency: 'FAIR',
    displayCurrency: currency,
    rates,
    now,
  });
  return (
    <div className="display-currency">
      <label htmlFor={id}>Display currency</label>{' '}
      <select
        id={id}
        value={currency}
        onChange={(event) => {
          const selected = event.target.value;
          if (!isDisplayCurrency(selected)) return;
          setCurrency(selected);
          const url = new URL(window.location.href);
          url.searchParams.delete('displayCurrency');
          window.history.replaceState(window.history.state, '', url.toString());
          try {
            localStorage.setItem(STORAGE_KEY, selected);
          } catch {
            /* Session-only when storage is unavailable. */
          }
        }}
      >
        {DISPLAY_CURRENCIES.map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
      </select>
      {currency !== 'FAIR' && (
        <p aria-live="polite">
          {display ? `Approx. ${display}` : `Equivalent in ${currency} unavailable`}
        </p>
      )}
      <p>The payment amount is fixed in FAIR. Display equivalents are estimates.</p>
    </div>
  );
}
