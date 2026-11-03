import type {
  CreateTaxCalculationParams,
  CreateTaxReversalParams,
  CreateTaxLocationEvidenceParams,
  List,
  ListTaxTransactionsParams,
  TaxCalculation,
  TaxCode,
  TaxLocationEvidence,
  TaxProductCode,
  TaxRegistration,
  TaxReport,
  TaxSettings,
  TaxTransaction,
  TaxTransactionList,
} from '@peable.to/shared-types';
import type { RestClient } from '../core/client';
import { type ApiListPromise, listPromise, listQuery } from '../core/list';
import { TaxComplianceResource } from './taxCompliance';

/**
 * Peable Tax for the merchant's server: what its tax settings and
 * registrations are, recording where a customer is, calculating, and reading
 * back what was collected. Registrations and the owner's approval are managed
 * in the Peable dashboard, never by a service credential.
 *
 * At checkout: `locationEvidence.create` with what you know of the customer
 * (billing address, payment-method or bank country, the IP address and the
 * country you resolved it to). Language, currency or timezone are not
 * evidence and are refused. Pass the returned id as `customer_location_evidence_id`
 * to `billing.createTaxQuote` or `tax.calculations.create`.
 */
export class TaxResource {
  readonly locationEvidence: {
    create(params: CreateTaxLocationEvidenceParams): Promise<TaxLocationEvidence>;
    retrieve(id: string): Promise<TaxLocationEvidence>;
  };
  readonly calculations: {
    create(params: CreateTaxCalculationParams): Promise<TaxCalculation>;
    retrieve(id: string): Promise<TaxCalculation>;
  };
  readonly products: {
    list(): Promise<List<TaxProductCode>>;
    /** Set a product's (billing plan's) tax code, e.g. `txcd_10103000` for SaaS. */
    setTaxCode(productRef: string, taxCode: string): Promise<TaxProductCode>;
  };
  readonly transactions: {
    /** Paid sales and their frozen calculations, newest first; refunds appear
     * as `type: "reversal"` rows naming the sale they reverse. `created`
     * filters the tax date (`committed_at`). */
    list(params?: ListTaxTransactionsParams): ApiListPromise<TaxTransaction, TaxTransactionList>;
    /** Record a refund made outside Peable (a FairCoin sale refunded from your
     * own wallet). Card refunds and credit notes are reversed automatically. */
    createReversal(id: string, params: CreateTaxReversalParams): Promise<TaxTransaction>;
  };
  readonly reports: {
    /** Totals per jurisdiction, registration, tax type and rate, for filings.
     * `from` is inclusive and `to` exclusive, both Unix seconds. */
    summary(params: { from: number; to: number }): Promise<TaxReport>;
  };
  /** Business compliance (ADR 0020): read the owner's records and the review queue, run assessments. */
  readonly compliance: TaxComplianceResource;

  constructor(private readonly client: RestClient) {
    this.compliance = new TaxComplianceResource(client);
    this.locationEvidence = {
      create: (params) => client.request('POST', '/v1/tax/location_evidence', { body: params }),
      retrieve: (id) =>
        client.request('GET', `/v1/tax/location_evidence/${encodeURIComponent(id)}`),
    };
    this.calculations = {
      create: (params) => client.request('POST', '/v1/tax/calculations', { body: params }),
      retrieve: (id) => client.request('GET', `/v1/tax/calculations/${encodeURIComponent(id)}`),
    };
    this.products = {
      list: () => client.request('GET', '/v1/tax/products'),
      setTaxCode: (productRef, taxCode) =>
        client.request('PUT', `/v1/tax/products/${encodeURIComponent(productRef)}`, {
          body: { tax_code: taxCode },
        }),
    };
    this.transactions = {
      list: (params = {}) =>
        listPromise(
          (page: ListTaxTransactionsParams) =>
            client.request<TaxTransactionList>('GET', '/v1/tax/transactions', {
              query: listQuery(page),
            }),
          params,
        ),
      createReversal: (id, params) =>
        client.request('POST', `/v1/tax/transactions/${encodeURIComponent(id)}/reversals`, {
          body: params,
        }),
    };
    this.reports = {
      summary: (params) =>
        client.request('GET', '/v1/tax/reports/summary', {
          query: { from: params.from, to: params.to },
        }),
    };
  }

  /** The merchant's tax settings: status (`active` once the owner approved), head office, defaults. */
  retrieveSettings(): Promise<TaxSettings> {
    return this.client.request('GET', '/v1/tax/settings');
  }
  listRegistrations(): Promise<List<TaxRegistration>> {
    return this.client.request('GET', '/v1/tax/registrations');
  }
  listCodes(): Promise<List<TaxCode>> {
    return this.client.request('GET', '/v1/tax/codes');
  }
}
