import { expect, it } from 'bun:test';
import { loadProviderSdk, type ProviderSdk } from '../providerJs';
it('shares the provider script load, rejects a failed load, and permits a fresh retry', async () => {
  const globals = globalThis as unknown as { document?: Document; Stripe?: () => ProviderSdk };
  const previousDocument = globals.document;
  const previousFactory = globals.Stripe;
  const scripts: Array<{
    src: string;
    async: boolean;
    onload?: () => void;
    onerror?: () => void;
    remove(): void;
  }> = [];
  let removed = 0;
  globals.document = {
    createElement: () => ({
      src: '',
      async: false,
      remove() {
        removed += 1;
      },
    }),
    head: { append: (script: (typeof scripts)[number]) => scripts.push(script) },
  } as unknown as Document;
  delete globals.Stripe;
  try {
    const first = loadProviderSdk();
    const same = loadProviderSdk();
    expect(first).toBe(same);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.src).toBe('https://js.stripe.com/endive/stripe.js');
    scripts[0]?.onerror?.();
    await expect(first).rejects.toThrow('could not be loaded');
    expect(removed).toBe(1);
    const retry = loadProviderSdk();
    expect(scripts).toHaveLength(2);
    const factory = () => ({}) as ProviderSdk;
    globals.Stripe = factory;
    scripts[1]?.onload?.();
    expect(await retry).toBe(factory);
    expect(await loadProviderSdk()).toBe(factory);
  } finally {
    if (previousDocument) globals.document = previousDocument;
    else delete globals.document;
    if (previousFactory) globals.Stripe = previousFactory;
    else delete globals.Stripe;
  }
});
