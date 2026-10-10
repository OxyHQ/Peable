// Typed env read for the checkout SPA. Vite only exposes `VITE_`-prefixed
// vars on `import.meta.env`; every var this app reads is declared here once
// so no other module inlines a magic string or a raw `import.meta.env.VITE_*`
// lookup.

/** Peable Gateway base URL — the REST + socket API this app talks to. */
export const GATEWAY_URL: string = import.meta.env.VITE_GATEWAY_URL ?? 'https://api.peable.to';

/** Custom URL scheme the wallet app registers for the "open in wallet" deep link. */
export const WALLET_DEEPLINK_SCHEME: string =
  import.meta.env.VITE_WALLET_DEEPLINK_SCHEME ?? 'peable';
