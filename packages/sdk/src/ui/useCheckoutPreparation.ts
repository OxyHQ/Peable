import { useEffect, useRef, useState } from 'react';
import {
  canPrepareCheckout,
  freezeCheckoutDetails,
  initialCheckoutDetails,
  SheetPreparationError,
  type SheetCheckoutDetails,
  type SheetCheckoutPreparation,
  type SheetPreparedCheckout,
} from './checkoutPreparation';
import { sessionSource } from './sheetCheckout';

/** The mounted preparation owns only its fields and in-flight work. Durable order identity stays in the host. */
export function useCheckoutPreparation(
  preparation: SheetCheckoutPreparation | undefined,
  connectionError: string,
) {
  // Account queries may finish after the sheet opens. Follow their defaults only until
  // the payer edits or submits; later account data must never overwrite either.
  const [editedDetails, setDetails] = useState<SheetCheckoutDetails | null>(null);
  const details = editedDetails ?? initialCheckoutDetails(preparation?.initialDetails);
  const [prepared, setPrepared] = useState<SheetPreparedCheckout | null>(null);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  const pending = useRef<AbortController | null>(null);
  const frozen = useRef<Readonly<SheetCheckoutDetails> | null>(null);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      pending.current?.abort();
    };
  }, []);

  const canContinue =
    !!preparation &&
    (locked ||
      (preparation.canContinue !== false && canPrepareCheckout(preparation.request, details)));

  function change(next: SheetCheckoutDetails) {
    if (frozen.current || pending.current || prepared) return;
    setDetails(next);
    setError(null);
  }

  async function submit() {
    if (!preparation || pending.current || prepared || !canContinue || !active.current) return;
    // Freeze before the callback: rapid repeated presses cannot create two orders, and a
    // lost response cannot cause a retry with a different destination or contact.
    const submitted = frozen.current ?? freezeCheckoutDetails(details);
    frozen.current = submitted;
    setDetails(submitted);
    const controller = new AbortController();
    pending.current = controller;
    setLocked(true);
    setBusy(true);
    setError(null);
    try {
      const result = await preparation.createSession(submitted, { signal: controller.signal });
      if (!active.current || controller.signal.aborted) return;
      const verified = sessionSource(result.source.clientSecret);
      if (result.source.type !== 'checkout_session' || verified?.id !== result.source.id)
        throw new Error('Invalid checkout session capability');
      setPrepared(result);
    } catch (failure) {
      if (!active.current || controller.signal.aborted) return;
      if (failure instanceof SheetPreparationError) {
        if (failure.outcome === 'not_created') {
          frozen.current = null;
          setLocked(false);
        }
        setError(failure.message);
      } else {
        // Network and unexpected errors are ambiguous. Never reset the host's order key.
        setError(connectionError);
      }
    } finally {
      if (pending.current === controller) pending.current = null;
      if (active.current && !controller.signal.aborted) setBusy(false);
    }
  }

  return { details, prepared, busy, locked, error, canContinue, change, submit };
}
