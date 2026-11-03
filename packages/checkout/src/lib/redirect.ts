// Leaving checkout for the merchant's `success_url`. One function, so the one
// navigation that ends a payment is in one place — and so tests can see it.
export function redirectTo(url: string): void {
  window.location.assign(url);
}
