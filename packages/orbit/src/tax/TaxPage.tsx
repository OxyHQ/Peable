import type { ComponentType } from 'react';
import { View } from 'react-native';
import { Text } from '@oxy.so/bloom/typography';
import type { DashboardScope } from '../api/dashboard';
import { t } from '../i18n';
import { OrbitScreen } from '../ui/OrbitScreen';
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

/**
 * One page of the workspace in Orbit's page template. Every page repeats the
 * boundary in one line: Peable records and assesses; only the owner turns
 * collection on, on the Collection page.
 */
export function TaxPage({ page }: { page: TaxPageKey }) {
  const Body = TAX_PAGES[page];
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
          <Body scope={scope} />
        </View>
      )}
    </OrbitScreen>
  );
}
