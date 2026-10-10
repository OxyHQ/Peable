/**
 * Bridge service client for the Buy-FAIR flow.
 *
 * Talks to the bridge orchestrator at https://bridge.fairco.in.
 * The base URL is overridable via Expo extra config so dev clients can point
 * at staging deployments without a rebuild.
 */

import Constants from 'expo-constants';

const DEFAULT_BRIDGE_BASE_URL = 'https://bridge.fairco.in';

function getBridgeBaseUrl(): string {
  const extra = Constants.expoConfig?.extra as { bridgeBaseUrl?: string } | undefined;
  return extra?.bridgeBaseUrl ?? DEFAULT_BRIDGE_BASE_URL;
}

export type PaymentCurrency = 'USDC_BASE' | 'ETH_BASE' | 'ETH_MAINNET' | 'BTC' | 'CARD';

export type BuyOrderStatus =
  | 'AWAITING_PAYMENT'
  | 'PAYMENT_DETECTED'
  | 'SWAPPING'
  | 'BURNING'
  | 'DELIVERING'
  | 'DELIVERED'
  | 'FAILED'
  | 'EXPIRED';

export interface BuyQuoteRequest {
  /** FAIR amount as a decimal string (e.g. "100" or "12.5"). */
  fairAmount: string;
  paymentCurrency: PaymentCurrency;
  fairDestinationAddress: string;
  /** Optional opaque per-install id; never PII. */
  userIdentifier?: string;
}

export interface BuyQuoteResponse {
  id: string;
  fairAmountSats: string;
  fairDestinationAddress: string;
  paymentCurrency: PaymentCurrency;
  /** Crypto path: send funds here. Null for CARD. */
  paymentAddress: string | null;
  /** Smallest-unit amount (microUSDC, wei, satoshi, …). */
  paymentAmount: string;
  /** Decimal-formatted user-facing amount, no trailing zeros. */
  paymentAmountFormatted: string;
  paymentDecimals: number;
  paymentSymbol: string;
  paymentNetworkLabel: string;
  /** CARD path: hosted Moonpay/Transak URL. Null for crypto. */
  cardPaymentUrl: string | null;
  paymentExpiresAt: string;
  estimatedDeliveryTime: string;
  feeBreakdown: {
    uniswapBps: number;
    bridgeBps: number;
    slippageBufferBps: number;
  };
}

export interface BuyStatusResponse {
  id: string;
  status: BuyOrderStatus;
  fairAmountSats: string;
  fairDestinationAddress: string;
  paymentCurrency: PaymentCurrency;
  paymentAddress: string | null;
  paymentAmount: string;
  paymentExpiresAt: string;
  paymentDetectedTxHash: string | null;
  swapTxHash: string | null;
  burnTxHash: string | null;
  fairDeliveryTxId: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export class BuyApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface BridgeErrorBody {
  error?: string;
  code?: string;
  message?: string;
  reason?: string;
  minimumFair?: string;
  maximumFair?: string;
}

async function parseErrorBody(response: Response): Promise<BridgeErrorBody> {
  try {
    return (await response.json()) as BridgeErrorBody;
  } catch {
    return {};
  }
}

async function bridgePost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${getBridgeBaseUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const err = await parseErrorBody(response);
    const code = err.code ?? err.error ?? null;
    const message =
      err.message ?? err.reason ?? err.error ?? `Bridge API error: ${response.status}`;
    throw new BuyApiError(message, response.status, code);
  }
  return (await response.json()) as T;
}

async function bridgeGet<T>(path: string): Promise<T> {
  const response = await fetch(`${getBridgeBaseUrl()}${path}`);
  if (!response.ok) {
    const err = await parseErrorBody(response);
    const code = err.code ?? err.error ?? null;
    const message =
      err.message ?? err.reason ?? err.error ?? `Bridge API error: ${response.status}`;
    throw new BuyApiError(message, response.status, code);
  }
  return (await response.json()) as T;
}

/**
 * Request a fresh buy quote. The bridge allocates a per-order payment
 * address (or a card-payment URL) and locks the price for the TTL window.
 */
export function requestBuyQuote(body: BuyQuoteRequest): Promise<BuyQuoteResponse> {
  return bridgePost<BuyQuoteResponse>('/api/buy/quote', body);
}

/**
 * Poll the lifecycle status of a buy order. Safe to call repeatedly.
 */
export function getBuyStatus(id: string): Promise<BuyStatusResponse> {
  return bridgeGet<BuyStatusResponse>(`/api/buy/status/${encodeURIComponent(id)}`);
}
