import type {
  CreateTaxRegistrationParams,
  TaxCode,
  TaxProductCode,
  TaxRegistration,
  TaxReport,
  TaxSettings,
  UpdateTaxSettingsParams,
} from '@peable.to/shared-types';
import { gateway } from './gateway-client';

export type TaxEnvironment = 'development' | 'production';
export interface TaxScope {
  applicationId: string;
  environment: TaxEnvironment;
}
interface List<T> {
  object: 'list';
  data: T[];
}

const path = (scope: TaxScope, rest: string) =>
  `/v1/dashboard/applications/${encodeURIComponent(scope.applicationId)}/tax${rest}${
    rest.includes('?') ? '&' : '?'
  }environment=${scope.environment}`;

/**
 * The owner's Peable Tax surface for one application and environment. The
 * gateway decides who may do what from oxy-api's own permissions
 * (`billing:read` to look, `billing:manage` to change and approve).
 */
export const taxDashboard = {
  settings: (scope: TaxScope) =>
    gateway.client.get<TaxSettings>(path(scope, '/settings'), { cache: false }),
  updateSettings: (scope: TaxScope, body: UpdateTaxSettingsParams) =>
    gateway.client.patch<TaxSettings>(path(scope, '/settings'), body),
  codes: (scope: TaxScope) =>
    gateway.client.get<List<TaxCode>>(path(scope, '/codes'), { cache: false }),
  registrations: (scope: TaxScope) =>
    gateway.client.get<List<TaxRegistration>>(path(scope, '/registrations'), { cache: false }),
  addRegistration: (scope: TaxScope, body: CreateTaxRegistrationParams) =>
    gateway.client.post<TaxRegistration>(path(scope, '/registrations'), body),
  deleteRegistration: (scope: TaxScope, id: string) =>
    gateway.client.delete<void>(path(scope, `/registrations/${encodeURIComponent(id)}`)),
  endRegistration: (scope: TaxScope, id: string, expiresAt: string) =>
    gateway.client.post<TaxRegistration>(
      path(scope, `/registrations/${encodeURIComponent(id)}/end`),
      { expiresAt },
    ),
  products: (scope: TaxScope) =>
    gateway.client.get<List<TaxProductCode>>(path(scope, '/products'), { cache: false }),
  setProductCode: (scope: TaxScope, productRef: string, taxCode: string) =>
    gateway.client.put<TaxProductCode>(path(scope, `/products/${encodeURIComponent(productRef)}`), {
      taxCode,
    }),
  approve: (scope: TaxScope) =>
    gateway.client.post<{ settings: TaxSettings; registrations: TaxRegistration[] }>(
      path(scope, '/approve'),
      {},
    ),
  report: (scope: TaxScope, from: string, to: string) =>
    gateway.client.get<TaxReport>(
      path(scope, `/reports/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
      { cache: false },
    ),
};
