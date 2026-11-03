import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Admonition, AdmonitionText } from '@oxy.so/bloom/admonition';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Loading } from '@oxy.so/bloom/loading';
import { Text } from '@oxy.so/bloom/typography';
import { describeError } from '../api/transport';
import { t } from '../i18n';
import { modeForEnvironment } from '../scope/scope';
import { useOrbitScope, type OrbitScopeValue } from '../scope/ScopeProvider';
import { useScreenBottomInset } from './navigation';
import { SearchBox } from '../search/SearchBox';
import { ScopeBar } from './ScopeBar';

/**
 * The frame of every Orbit screen: the scope bar, the search box (once an
 * application is chosen), a test-mode notice, a title, and a centred column that reads at desktop width and narrows to a phone.
 *
 * `children` is a function of the selected scope and is called only once an
 * application is chosen; until then the frame explains what is missing.
 */
export function OrbitScreen({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: (
    scope: OrbitScopeValue & { scope: NonNullable<OrbitScopeValue['scope']> },
  ) => ReactNode;
}) {
  const scope = useOrbitScope();
  const bottom = useScreenBottomInset();
  const test = modeForEnvironment(scope.environment) === 'test';

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
      contentContainerStyle={{ paddingBottom: bottom + 32 }}
      keyboardShouldPersistTaps="handled"
    >
      <View className="w-full max-w-6xl self-center px-4 pt-6 gap-6 md:px-8">
        <ScopeBar />
        {scope.scope ? (
          <SearchBox
            key={`${scope.scope.applicationId}:${scope.scope.environment}`}
            scope={scope.scope}
          />
        ) : null}
        {test ? (
          <Admonition type="info">
            <AdmonitionText>{t('scope.testBanner')}</AdmonitionText>
          </Admonition>
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
          {actions}
        </View>
        {body}
      </View>
    </ScrollView>
  );
}

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

/** Label / value rows, side by side when there is room. */
export function Field({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <View className="flex-row flex-wrap gap-x-4 gap-y-1 py-2 border-b border-border">
      <Text variant="body-2-medium" className="text-muted-foreground w-44">
        {label}
      </Text>
      {typeof value === 'string' || typeof value === 'number' ? (
        <Text
          variant="body-2-regular"
          selectable
          className={mono ? 'font-mono flex-1 min-w-48' : 'flex-1 min-w-48'}
        >
          {value}
        </Text>
      ) : (
        <View className="flex-1 min-w-48">{value}</View>
      )}
    </View>
  );
}
