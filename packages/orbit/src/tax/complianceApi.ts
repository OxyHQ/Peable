import type {
  CreateTaxDocumentParams,
  CreateTaxOperatingLocationParams,
  CreateTaxRegistrationDeclarationParams,
  CreateTaxSalesDestinationParams,
  ResolveTaxReviewItemParams,
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
  TaxReviewItemStatus,
  TaxRuleSet,
  TaxSalesDestination,
  UpdateTaxBusinessProfileParams,
  UpdateTaxOperatingLocationParams,
  UpdateTaxRegistrationDeclarationParams,
  UpdateTaxSalesDestinationParams,
} from '@peable.to/shared-types/tax';
import { assertList, type DashboardScope, dashboardPath, type ListPage } from '../api/dashboard';
import type { OrbitTransport } from '../api/transport';

/** The widest page the gateway serves: Orbit reads a merchant's compliance records in one go. */
export const COMPLIANCE_PAGE = 100;

const id = (value: string) => encodeURIComponent(value);

/**
 * Peable Tax business compliance (ADR 0020) for the application's owner:
 * `billing:read` to look, `billing:manage` for every write and decision.
 * Nothing here can turn collection on; that stays the Collection tab's
 * registration plus approval.
 */
export function createTaxComplianceApi(transport: OrbitTransport) {
  const path = (scope: DashboardScope, rest: string, query?: Record<string, string | number>) =>
    dashboardPath(scope, `/tax${rest}`, query);
  const get = <T>(scope: DashboardScope, rest: string, query?: Record<string, string | number>) =>
    transport.request<T>('GET', path(scope, rest, query));
  const list = async <T>(
    scope: DashboardScope,
    rest: string,
    query: Record<string, string | number> = {},
  ): Promise<ListPage<T>> =>
    assertList<T>(await get<unknown>(scope, rest, { limit: COMPLIANCE_PAGE, ...query }));
  const post = <T>(scope: DashboardScope, rest: string, body: unknown) =>
    transport.request<T>('POST', path(scope, rest), { body });

  return {
    profile: (scope: DashboardScope) => get<TaxBusinessProfile>(scope, '/business_profile'),
    updateProfile: (scope: DashboardScope, body: UpdateTaxBusinessProfileParams) =>
      post<TaxBusinessProfile>(scope, '/business_profile', body),
    locations: (scope: DashboardScope) => list<TaxOperatingLocation>(scope, '/operating_locations'),
    addLocation: (scope: DashboardScope, body: CreateTaxOperatingLocationParams) =>
      post<TaxOperatingLocation>(scope, '/operating_locations', body),
    updateLocation: (
      scope: DashboardScope,
      locationId: string,
      body: UpdateTaxOperatingLocationParams,
    ) => post<TaxOperatingLocation>(scope, `/operating_locations/${id(locationId)}`, body),
    destinations: (scope: DashboardScope) =>
      list<TaxSalesDestination>(scope, '/sales_destinations'),
    addDestination: (scope: DashboardScope, body: CreateTaxSalesDestinationParams) =>
      post<TaxSalesDestination>(scope, '/sales_destinations', body),
    updateDestination: (
      scope: DashboardScope,
      destinationId: string,
      body: UpdateTaxSalesDestinationParams,
    ) => post<TaxSalesDestination>(scope, `/sales_destinations/${id(destinationId)}`, body),
    declarations: (scope: DashboardScope) =>
      list<TaxRegistrationDeclaration>(scope, '/registration_declarations'),
    addDeclaration: (scope: DashboardScope, body: CreateTaxRegistrationDeclarationParams) =>
      post<TaxRegistrationDeclaration>(scope, '/registration_declarations', body),
    updateDeclaration: (
      scope: DashboardScope,
      declarationId: string,
      body: UpdateTaxRegistrationDeclarationParams,
    ) =>
      post<TaxRegistrationDeclaration>(
        scope,
        `/registration_declarations/${id(declarationId)}`,
        body,
      ),
    documents: (scope: DashboardScope) => list<TaxDocument>(scope, '/documents'),
    attachDocument: (scope: DashboardScope, body: CreateTaxDocumentParams) =>
      post<TaxDocument>(scope, '/documents', body),
    checklist: (scope: DashboardScope) => get<TaxDocumentChecklist>(scope, '/document_checklist'),
    ruleSet: (scope: DashboardScope) => get<TaxRuleSet>(scope, '/rule_set'),
    capabilities: (scope: DashboardScope) => get<TaxComplianceCapabilities>(scope, '/capabilities'),
    deadlines: (scope: DashboardScope) => get<TaxDeadlineList>(scope, '/deadlines'),
    assessments: (scope: DashboardScope) =>
      list<TaxAssessment>(scope, '/assessments', { limit: 1 }),
    assess: (scope: DashboardScope) => post<TaxAssessment>(scope, '/assessments', {}),
    replay: (scope: DashboardScope, assessmentId: string) =>
      get<TaxAssessmentReplay>(scope, `/assessments/${id(assessmentId)}/replay`),
    reviewItems: (scope: DashboardScope, status?: TaxReviewItemStatus) =>
      list<TaxReviewItem>(scope, '/review_items', status ? { status } : {}),
    resolveReviewItem: (scope: DashboardScope, itemId: string, body: ResolveTaxReviewItemParams) =>
      post<TaxReviewItem>(scope, `/review_items/${id(itemId)}/resolve`, body),
    actions: (scope: DashboardScope) => list<TaxComplianceAction>(scope, '/compliance_actions'),
  };
}

export type TaxComplianceApi = ReturnType<typeof createTaxComplianceApi>;
