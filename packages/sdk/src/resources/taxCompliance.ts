import type {
  CreateTaxAssessmentParams,
  List,
  ListParams,
  ListTaxReviewItemsParams,
  TaxAssessment,
  TaxAssessmentReplay,
  TaxBusinessProfile,
  TaxComplianceAction,
  TaxComplianceCapabilities,
  TaxDeadlineList,
  TaxDocument,
  TaxDocumentChecklist,
  TaxOperatingLocation,
  TaxRegistrationDeclaration,
  TaxReviewItem,
  TaxRuleSet,
  TaxSalesDestination,
} from '@peable.to/shared-types';
import type { RestClient } from '../core/client';
import { type ApiListPromise, listPromise, listQuery } from '../core/list';

/**
 * Peable Tax business compliance (ADR 0020), as a merchant's server sees it:
 * READ everything the owner recorded and the review queue, and run an
 * assessment. Onboarding facts and review decisions are the owner's, in
 * Orbit; no method here records one, and nothing here turns tax collection
 * on or registers, files or pays anything with an authority.
 */
export class TaxComplianceResource {
  constructor(private readonly client: RestClient) {}

  private list<T extends { id: string }, P extends ListParams>(
    path: string,
    params: P,
    filters: (page: P) => Record<string, string | undefined> = () => ({}),
  ): ApiListPromise<T, List<T>> {
    return listPromise(
      (page: P) =>
        this.client.request<List<T>>('GET', `/v1/tax${path}`, {
          query: listQuery(page, filters(page)),
        }),
      params,
    );
  }

  private get<T>(path: string): Promise<T> {
    return this.client.request<T>('GET', `/v1/tax${path}`);
  }

  /** The business behind the merchant; `missing` lists what onboarding lacks. */
  retrieveBusinessProfile(): Promise<TaxBusinessProfile> {
    return this.get('/business_profile');
  }
  listOperatingLocations(
    params: ListParams = {},
  ): ApiListPromise<TaxOperatingLocation, List<TaxOperatingLocation>> {
    return this.list('/operating_locations', params);
  }
  listSalesDestinations(
    params: ListParams = {},
  ): ApiListPromise<TaxSalesDestination, List<TaxSalesDestination>> {
    return this.list('/sales_destinations', params);
  }
  /** Declared registration statuses — always `unverified`; never what Peable collects under. */
  listRegistrationDeclarations(
    params: ListParams = {},
  ): ApiListPromise<TaxRegistrationDeclaration, List<TaxRegistrationDeclaration>> {
    return this.list('/registration_declarations', params);
  }
  listDocuments(params: ListParams = {}): ApiListPromise<TaxDocument, List<TaxDocument>> {
    return this.list('/documents', params);
  }
  retrieveDocumentChecklist(): Promise<TaxDocumentChecklist> {
    return this.get('/document_checklist');
  }
  /** The versioned rule set: supported rules with sources, effective dates and coverage limits. */
  retrieveRuleSet(): Promise<TaxRuleSet> {
    return this.get('/rule_set');
  }
  /** What is available, limited, not available or out of scope — stated, never simulated. */
  retrieveCapabilities(): Promise<TaxComplianceCapabilities> {
    return this.get('/capabilities');
  }
  /** Due dates the rule set can compute, and where it cannot, why. */
  listDeadlines(): Promise<TaxDeadlineList> {
    return this.get('/deadlines');
  }

  /** Run an assessment now (or `as_of` a past instant). Findings open review items; nothing activates. */
  createAssessment(params: CreateTaxAssessmentParams = {}): Promise<TaxAssessment> {
    return this.client.request('POST', '/v1/tax/assessments', { body: params });
  }
  retrieveAssessment(id: string): Promise<TaxAssessment> {
    return this.get(`/assessments/${encodeURIComponent(id)}`);
  }
  listAssessments(params: ListParams = {}): ApiListPromise<TaxAssessment, List<TaxAssessment>> {
    return this.list('/assessments', params);
  }
  /** Re-run a stored assessment's inputs through its own rule set version. */
  replayAssessment(id: string): Promise<TaxAssessmentReplay> {
    return this.get(`/assessments/${encodeURIComponent(id)}/replay`);
  }

  listReviewItems(
    params: ListTaxReviewItemsParams = {},
  ): ApiListPromise<TaxReviewItem, List<TaxReviewItem>> {
    return this.list('/review_items', params, (page) => ({ status: page.status }));
  }
  retrieveReviewItem(id: string): Promise<TaxReviewItem> {
    return this.get(`/review_items/${encodeURIComponent(id)}`);
  }
  /** The action history: who changed what, newest first. */
  listActions(
    params: ListParams = {},
  ): ApiListPromise<TaxComplianceAction, List<TaxComplianceAction>> {
    return this.list('/compliance_actions', params);
  }
}
