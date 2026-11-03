import { createContext, useContext, type ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Breadcrumb, BreadcrumbItem } from '@oxy.so/bloom/breadcrumb';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Loading } from '@oxy.so/bloom/loading';
import { Text } from '@oxy.so/bloom/typography';
import { describeError } from '../api/transport';
import { t } from '../i18n';
import { modeForEnvironment } from '../scope/scope';
import { useOrbitScope, type OrbitScopeValue } from '../scope/ScopeProvider';
import { breadcrumbTrail, type Crumb } from '../shell/destinations';
import { DETAIL_ASIDE_WIDTH, DETAIL_MAIN_MIN_WIDTH } from '../shell/layout';

/**
 * The page template every Orbit screen renders in, Stripe's: a breadcrumb
 * trail on a page below a destination (derived from the route by the
 * navigation registry, so a detail screen states nothing), the title with its
 * description and primary actions, an optional filters row, then the page.
 * The organization / application and Test / Live are the shell's (sidebar
 * switcher, top bar, test strip) — never repeated here.
 *
 * `children` is a function of the selected scope and is called only once an
 * application is chosen; until then the frame explains what is missing.
 */
export function OrbitScreen({
  title,
  description,
  actions,
  filters,
  breadcrumbs,
  children,
}: {
  title: string;
  description?: string;
  /** The page's primary actions, at the header's end edge. */
  actions?: ReactNode;
  /** A list page's filters, in a row under the header. */
  filters?: ReactNode;
  /** Overrides the trail derived from the route. */
  breadcrumbs?: Crumb[];
  children: (
    scope: OrbitScopeValue & { scope: NonNullable<OrbitScopeValue['scope']> },
  ) => ReactNode;
}) {
  const scope = useOrbitScope();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const trail = breadcrumbs ?? breadcrumbTrail(pathname, title);

  let body: ReactNode;
  if (scope.error) {
    body = <ErrorNotice error={scope.error} onRetry={scope.retry} />;
  } else if (scope.organizationsLoading) {
    body = <Loading accessibilityLabel={t('scope.loading')} />;
  } else if (!scope.organizations.length) {
    body = (
      <EmptyState
        title={t('scope.noOrganizations.title')}
        description={t('scope.noOrganizations.body')}
      />
    );
  } else if (scope.applicationsLoading) {
    body = <Loading accessibilityLabel={t('scope.loading')} />;
  } else if (!scope.scope) {
    body = (
      <EmptyState
        title={t('scope.noApplications.title')}
        description={t('scope.noApplications.body')}
      />
    );
  } else {
    body = children({ ...scope, scope: scope.scope });
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ paddingBottom: insets.bottom + 48 }}
      keyboardShouldPersistTaps="handled"
    >
      <View className="w-full max-w-7xl self-center px-4 pt-5 gap-6 md:px-8 md:pt-8">
        <PageHeading title={title} description={description} actions={actions} trail={trail} />
        {filters ? <FilterBar>{filters}</FilterBar> : null}
        {body}
      </View>
    </ScrollView>
  );
}

function PageHeading({
  title,
  description,
  actions,
  trail,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  trail: Crumb[];
}) {
  const router = useRouter();
  return (
    <View className="gap-2">
      {trail.length ? (
        <Breadcrumb size="sm" overflow="collapse" accessibilityLabel={t('shell.breadcrumb')}>
          {trail.map((crumb, index) =>
            index === trail.length - 1 ? (
              <BreadcrumbItem key={crumb.label} current>
                {crumb.label}
              </BreadcrumbItem>
            ) : (
              <BreadcrumbItem
                key={crumb.label}
                href={crumb.href}
                onPress={crumb.href ? () => router.navigate(crumb.href as never) : undefined}
              >
                {t(crumb.label)}
              </BreadcrumbItem>
            ),
          )}
        </Breadcrumb>
      ) : null}
      <View className="flex-row flex-wrap items-center justify-between gap-3">
        <View className="gap-1 flex-1 min-w-64">
          <Text variant="title-2-semibold" accessibilityRole="header">
            {title}
          </Text>
          {description ? (
            <Text variant="body-regular" className="text-muted-foreground">
              {description}
            </Text>
          ) : null}
        </View>
        {actions ? <View className="flex-row flex-wrap items-center gap-2">{actions}</View> : null}
      </View>
    </View>
  );
}

/** A list page's filters: one wrapping row, under a hairline, as Stripe draws them. */
export function FilterBar({ children }: { children: ReactNode }) {
  return (
    <View className="flex-row flex-wrap items-end gap-3 border-b border-border pb-4">
      {children}
    </View>
  );
}

/** What `ListFooter` reads of an infinite query over a cursor-paged list. */
export interface CursorPages {
  data?: { pages: ReadonlyArray<{ data: readonly unknown[] }> };
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => unknown;
}

/**
 * The foot of a cursor-paged list: how many rows are shown and, while the
 * gateway says `has_more`, the button that fetches the next page. Lists page
 * by `starting_after`, so there is no total to number pages against.
 */
export function ListFooter({ pages }: { pages: CursorPages }) {
  const count = pages.data?.pages.reduce((sum, page) => sum + page.data.length, 0) ?? 0;
  const hasMore = pages.hasNextPage;
  if (!count && !hasMore) return null;
  return (
    <View className="flex-row flex-wrap items-center justify-between gap-3">
      <Text variant="body-2-regular" className="text-muted-foreground">
        {t('shell.list.count', { count })}
      </Text>
      {hasMore ? (
        <Button
          appearance="outline"
          size="sm"
          loading={pages.isFetchingNextPage}
          onPress={() => void pages.fetchNextPage()}
        >
          {t('action.loadMore')}
        </Button>
      ) : null}
    </View>
  );
}

/**
 * A detail page's two columns, Stripe's: the object's main content, and a side
 * panel of its attributes beside it on a wide page — under it on a narrow one.
 * `Field`s inside the side panel stack their label over their value.
 */
export function DetailLayout({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  // No measuring: a wrapping row where the main column grows 999 times faster
  // than the panel. Side by side the panel keeps its basis; once the row is
  // too narrow for both bases the panel wraps under and grows to the width.
  return (
    <View className="flex-row flex-wrap items-start gap-6">
      <View className="gap-6" style={DETAIL_MAIN_STYLE}>
        {children}
      </View>
      {aside !== undefined ? (
        <FieldLayoutContext.Provider value="stacked">
          <View className="gap-6" style={DETAIL_ASIDE_STYLE}>
            {aside}
          </View>
        </FieldLayoutContext.Provider>
      ) : null}
    </View>
  );
}

const DETAIL_MAIN_STYLE = {
  flexGrow: 999,
  flexShrink: 1,
  flexBasis: DETAIL_MAIN_MIN_WIDTH,
  minWidth: 0,
} as const;
const DETAIL_ASIDE_STYLE = { flexGrow: 1, flexShrink: 1, flexBasis: DETAIL_ASIDE_WIDTH } as const;

/** A refusal or failure, in the gateway's own words and with its request id. */
export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <EmptyState
      variant="compact"
      title={t('error.generic')}
      description={describeError(error, t('error.generic'))}
      {...(onRetry ? { action: { label: t('action.retry'), onPress: onRetry } } : {})}
    />
  );
}

/** What a merchant-scoped screen shows before the application has a merchant in this mode. */
export function MerchantMissing({ environment }: { environment: OrbitScopeValue['environment'] }) {
  const router = useRouter();
  return (
    <EmptyState
      title={t('merchant.missing.title')}
      description={t('merchant.missing.body', {
        mode: t(modeForEnvironment(environment) === 'live' ? 'scope.live' : 'scope.test'),
      })}
      action={{ label: t('merchant.missing.action'), onPress: () => router.navigate('/settings') }}
    />
  );
}

/**
 * What a money screen shows when the merchant has no fiat account in this
 * mode (`account_missing`): an explanation and the way to open one — never a
 * zero balance.
 */
export function AccountMissing({ environment }: { environment: OrbitScopeValue['environment'] }) {
  const router = useRouter();
  return (
    <EmptyState
      title={t('money.accountMissing.title')}
      description={t('money.accountMissing.body', {
        mode: t(modeForEnvironment(environment) === 'live' ? 'scope.live' : 'scope.test'),
      })}
      action={{
        label: t('money.accountMissing.action'),
        onPress: () => router.navigate('/account'),
      }}
    />
  );
}

/** A titled group of content on a card surface. */
export function Section({
  title,
  description,
  children,
  actions,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <View className="gap-3 rounded-2xl border border-border bg-card p-4 md:p-6">
      {title || actions ? (
        <View className="flex-row flex-wrap items-center justify-between gap-2">
          {title ? (
            <Text variant="headline-semibold" accessibilityRole="header">
              {title}
            </Text>
          ) : null}
          {actions}
        </View>
      ) : null}
      {description ? (
        <Text variant="body-2-regular" className="text-muted-foreground">
          {description}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

/** How `Field` lays out: label beside value, or (in a detail side panel) above it. */
const FieldLayoutContext = createContext<'row' | 'stacked'>('row');

/** Label / value rows, side by side when there is room. */
export function Field({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  const stacked = useContext(FieldLayoutContext) === 'stacked';
  const valueClass = stacked ? '' : 'flex-1 min-w-48';
  return (
    <View
      className={
        stacked
          ? 'gap-0.5 py-2 border-b border-border'
          : 'flex-row flex-wrap gap-x-4 gap-y-1 py-2 border-b border-border'
      }
    >
      <Text
        variant={stacked ? 'caption-1-medium' : 'body-2-medium'}
        className={stacked ? 'text-muted-foreground' : 'text-muted-foreground w-44'}
      >
        {label}
      </Text>
      {typeof value === 'string' || typeof value === 'number' ? (
        <Text
          variant="body-2-regular"
          selectable
          className={mono ? `font-mono ${valueClass}` : valueClass}
        >
          {value}
        </Text>
      ) : (
        <View className={valueClass}>{value}</View>
      )}
    </View>
  );
}
