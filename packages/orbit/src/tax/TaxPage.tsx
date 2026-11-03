import type { ComponentType } from 'react';
import { View } from 'react-native';
import { Text } from '@oxy.so/bloom/typography';
import type { DashboardScope } from '../api/dashboard';
import { t } from '../i18n';
import { useDashboardPermissions } from '../scope/useDashboardPermissions';
import { OrbitScreen } from '../ui/OrbitScreen';
import { PermissionNotice } from '../ui/states';
import { CollectionSettings } from './CollectionSettings';
import {
  BusinessSection,
  DeadlinesSection,
  DocumentsSection,
  HistorySection,
  OverviewSection,
  RegistrationsSection,
  ReviewSection,
} from './ComplianceSections';

/** The Tax workspace's pages (ADR 0020), each its own route under `/tax`. */
export const TAX_PAGES = {
  overview: OverviewSection,
  business: BusinessSection,
  registrations: RegistrationsSection,
  documents: DocumentsSection,
  review: ReviewSection,
  deadlines: DeadlinesSection,
  history: HistorySection,
  collection: CollectionSettings,
} as const satisfies Record<string, ComponentType<{ scope: DashboardScope }>>;
export type TaxPageKey = keyof typeof TAX_PAGES;

/** The pages that only read: everything else records, assesses or decides (`money`). */
const READ_ONLY_PAGES: ReadonlySet<TaxPageKey> = new Set(['deadlines', 'history']);

/**
 * One page of the workspace in Orbit's page template. Every page repeats the
 * boundary in one line: Peable records and assesses; only the owner turns
 * collection on, on the Collection page.
 *
 * Peable Tax is read with `taxRead` (`billing:read`, or `billing:manage`) and
 * changed with `money`: without the first the page says so and asks nothing
 * of the gateway; without the second it is read-only and says why once.
 */
export function TaxPage({ page }: { page: TaxPageKey }) {
  const Body = TAX_PAGES[page];
  const { can } = useDashboardPermissions();
  return (
    <OrbitScreen
      title={page === 'overview' ? t('nav.tax') : t(`compliance.section.${page}`)}
      description={t(`compliance.page.${page}`)}
    >
      {({ scope }) => (
        <View className="gap-6" key={`${scope.applicationId}:${scope.environment}`}>
          <Text variant="caption-1-regular" className="text-muted-foreground">
            {t('compliance.boundary')}
          </Text>
          {can('taxRead') ? (
            <>
              {READ_ONLY_PAGES.has(page) ? null : <PermissionNotice action="money" />}
              <Body scope={scope} />
            </>
          ) : (
            <PermissionNotice action="taxRead" />
          )}
        </View>
      )}
    </OrbitScreen>
  );
}
