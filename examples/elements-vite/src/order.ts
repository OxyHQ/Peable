// The page and the server agree on this one shape: what the SERVER says an
// order is, decided from the payment it reads from Peable.

export type OrderStatus = 'awaiting_payment' | 'processing' | 'paid' | 'canceled';

export interface OrderView {
  id: string;
  status: OrderStatus;
  /** Base units, as a string (`'1800'` is 18.00). */
  amount: string;
  currency: string;
  /** Only while the payer still has to pay: what the Elements confirm. */
  payment_intent: { id: string; client_secret: string } | null;
}
