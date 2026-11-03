import { createContext, useContext, useState } from 'react';
import { Linking, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@oxy.so/services/ui/client';
import {
  AdmonitionButton,
  AdmonitionContent,
  AdmonitionIcon,
  AdmonitionRoot,
  AdmonitionRow,
  AdmonitionText,
} from '@oxy.so/bloom/admonition';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Text } from '@oxy.so/bloom/typography';
import { OXY_CONSOLE_URL } from '../config';
import { t } from '../i18n';
import { modeForEnvironment } from '../scope/scope';
import { useOrbitScope } from '../scope/ScopeProvider';
import type { OrbitEnvironment } from '../api/dashboard';
import { docsUrl, type DocsTopic } from './docs';
import { errorState, type ErrorState } from './errorState';

/**
 * Orbit's page states, Stripe's way: nothing a gateway answers is drawn as a
 * bare "something went wrong". `ErrorNotice` reads the thrown value through
 * `errorState` and shows what is TRUE — a first run, a permission someone can
 * grant, a feature that is off, an object that does not exist — and only a
 * genuine failure as an inline, dismissible banner with the request id and
 * Retry, so the rest of the page keeps whatever it loaded.
 */

const modeWord = (environment: OrbitEnvironment) =>
  t(modeForEnvironment(environment) === 'live' ? 'state.mode.live' : 'state.mode.test');

const openUrl = (url: string) => () => void Linking.openURL(url);

/** The one state component a screen renders for a failed query. */
export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return <StateFor state={errorState(error)} onRetry={onRetry} />;
}

export function StateFor({ state, onRetry }: { state: ErrorState; onRetry?: () => void }) {
  const { environment } = useOrbitScope();
  switch (state.kind) {
    case 'merchant_missing':
      return <SetupPayments environment={environment} />;
    case 'account_missing':
      return <AccountMissing environment={environment} />;
    case 'feature_unavailable':
      return (
        <EmptyState
          variant="compact"
          title={t('state.tax.title')}
          description={t('state.tax.body')}
        />
      );
    case 'permission':
      return <PermissionNotice state={state} />;
    case 'session':
      return <SessionEnded />;
    case 'not_found':
      return (
        <EmptyState
          variant="compact"
          title={t('state.notFound.title')}
          description={t('state.notFound.body', { mode: modeWord(environment) })}
        />
      );
    case 'invalid':
    case 'failure':
      return <FailureBanner state={state} onRetry={onRetry} />;
  }
}

/** Whether a detail page's query failed because its object does not exist (in this mode). */
export function isNotFound(error: unknown): boolean {
  return errorState(error).kind === 'not_found';
}

/** A detail page's object does not exist in this mode: its own title, and where else it could be. */
export function NotFound({ title }: { title: string }) {
  const { environment } = useOrbitScope();
  return (
    <EmptyState
      testID="state-not-found"
      variant="compact"
      title={title}
      description={t('state.notFound.body', { mode: modeWord(environment) })}
    />
  );
}

/**
 * First run in a mode: the application has no merchant here yet. Stripe's
 * "Start accepting payments" — the action that sets it up, the guide, and in
 * live mode the way back to test mode, which is always usable.
 */
export function SetupPayments({ environment }: { environment: OrbitEnvironment }) {
  const router = useRouter();
  const { setEnvironment } = useOrbitScope();
  const live = modeForEnvironment(environment) === 'live';
  return (
    <EmptyState
      testID="state-setup-payments"
      title={t('state.setup.title', { mode: modeWord(environment) })}
      description={t(live ? 'state.setup.body.live' : 'state.setup.body.test')}
      action={{ label: t('state.setup.action'), onPress: () => router.navigate('/settings') }}
      secondaryAction={
        live
          ? { label: t('state.setup.useTest'), onPress: () => setEnvironment('development') }
          : { label: t('state.setup.docs'), onPress: openUrl(docsUrl('testMode')) }
      }
    />
  );
}

/** @deprecated name kept for the screens that import it: the first-run state. */
export const MerchantMissing = SetupPayments;

/**
 * What a money screen shows when the merchant has no fiat account in this
 * mode (`account_missing`): an explanation and the way to open one — never a
 * zero balance.
 */
export function AccountMissing({ environment }: { environment: OrbitEnvironment }) {
  const router = useRouter();
  return (
    <EmptyState
      testID="state-account-missing"
      title={t('money.accountMissing.title')}
      description={t('money.accountMissing.body', { mode: modeWord(environment) })}
      action={{
        label: t('money.accountMissing.action'),
        onPress: () => router.navigate('/account'),
      }}
    />
  );
}

/** A permission refusal: which permission, and who grants it (Oxy Console). */
export function PermissionNotice({
  state,
}: {
  state: Extract<ErrorState, { kind: 'permission' }>;
}) {
  const description = state.membership
    ? t('state.permission.bodyMembership')
    : state.permission
      ? t('state.permission.body', { permission: state.permission })
      : t('state.permission.bodyGeneric');
  return (
    <EmptyState
      testID="state-permission"
      variant="compact"
      title={t(state.membership ? 'state.permission.membershipTitle' : 'state.permission.title')}
      description={description}
      action={{ label: t('state.permission.action'), onPress: openUrl(OXY_CONSOLE_URL) }}
    />
  );
}

function SessionEnded() {
  const { signIn } = useAuth();
  return (
    <EmptyState
      testID="state-session"
      variant="compact"
      title={t('state.session.title')}
      description={t('state.session.body')}
      action={{ label: t('state.session.action'), onPress: () => void signIn() }}
    />
  );
}

/** The sentence a failure banner leads with. */
export function failureSentence(state: Extract<ErrorState, { kind: 'failure' | 'invalid' }>) {
  if (state.kind === 'invalid') return t('state.failure.invalid');
  return t(`state.failure.${state.reason}`);
}

/**
 * Set while the page itself shows a failure banner (`OrbitScreen`'s probe
 * failed): a section that fails in the same outage stays quiet instead of
 * stacking a second banner under the first — the page's Retry reloads it too.
 */
export const PageFailureContext = createContext(false);

/**
 * A real failure, inline above the content: a specific sentence, the
 * gateway's own words when it gave any, the request id support needs, Retry,
 * and Dismiss. Never a page-wide headline.
 */
export function FailureBanner({
  state,
  onRetry,
  sentence,
  page = false,
}: {
  state: Extract<ErrorState, { kind: 'failure' | 'invalid' }>;
  onRetry?: () => void;
  /** Overrides the leading sentence (the scope picker names Oxy, not Peable). */
  sentence?: string;
  /** The page's own banner, which a section's never hides. */
  page?: boolean;
}) {
  const [dismissed, setDismissed] = useState(false);
  const pageShowsOne = useContext(PageFailureContext);
  if (dismissed || (pageShowsOne && !page && state.kind === 'failure')) return null;
  const lead = sentence ?? failureSentence(state);
  const detail = state.message && state.message !== lead ? state.message : null;
  return (
    <View testID="state-failure" accessibilityRole="alert">
      <AdmonitionRoot type={state.kind === 'invalid' ? 'warning' : 'error'}>
        <AdmonitionRow>
          <AdmonitionIcon />
          <AdmonitionContent>
            <AdmonitionText>{detail ? `${lead} ${detail}` : lead}</AdmonitionText>
            {state.requestId ? (
              <Text
                variant="caption-1-regular"
                selectable
                className="font-mono text-muted-foreground"
              >
                {t('state.failure.requestId', { id: state.requestId })}
              </Text>
            ) : null}
            <View className="flex-row flex-wrap gap-2 pt-1">
              {onRetry ? (
                <AdmonitionButton appearance="outline" onPress={onRetry}>
                  {t('state.failure.retry')}
                </AdmonitionButton>
              ) : null}
              <AdmonitionButton appearance="plain" onPress={() => setDismissed(true)}>
                {t('state.failure.dismiss')}
              </AdmonitionButton>
            </View>
          </AdmonitionContent>
        </AdmonitionRow>
      </AdmonitionRoot>
    </View>
  );
}

/**
 * An empty list, Stripe's: what the object is for, the primary action, and
 * where to learn more — never "No data".
 */
export function ListEmpty({
  title,
  description,
  action,
  docs,
}: {
  title: string;
  description: string;
  action?: { label: string; onPress: () => void };
  docs?: DocsTopic;
}) {
  return (
    <EmptyState
      testID="state-empty"
      variant="compact"
      title={title}
      description={description}
      {...(action ? { action } : {})}
      {...(docs
        ? { secondaryAction: { label: t('state.docs'), onPress: openUrl(docsUrl(docs)) } }
        : {})}
    />
  );
}

export type SkeletonVariant = 'table' | 'detail' | 'tiles' | 'form';

/**
 * A placeholder shaped like the page that is loading — rows under column
 * headers, a detail header and its side panel, summary tiles, a form — so the
 * page does not jump when it arrives. Never a spinner in an empty page.
 */
export function PageSkeleton({
  variant = 'table',
  rows = 6,
  accessibilityLabel,
}: {
  variant?: SkeletonVariant;
  rows?: number;
  accessibilityLabel?: string;
}) {
  return (
    <Skeleton.Region label={accessibilityLabel ?? t('state.loading')} testID="state-loading">
      {variant === 'table' ? <TableBones rows={rows} /> : null}
      {variant === 'tiles' ? <TileBones /> : null}
      {variant === 'detail' ? <DetailBones /> : null}
      {variant === 'form' ? <FormBones rows={rows} /> : null}
    </Skeleton.Region>
  );
}

/** A placeholder's columns, keyed (a skeleton has no data to key rows by). */
const CELLS = [
  { key: 'a', width: '18%' },
  { key: 'b', width: '14%' },
  { key: 'c', width: '10%' },
  { key: 'd', width: '30%' },
  { key: 'e', width: '16%' },
] as const;
/** Stable keys for up to ten placeholder rows. */
const ROW_KEYS = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9'] as const;

function TableBones({ rows }: { rows: number }) {
  const keys = ROW_KEYS.slice(0, Math.max(1, Math.min(rows, ROW_KEYS.length)));
  return (
    <View className="rounded-2xl border border-border overflow-hidden">
      <View className="flex-row gap-4 px-3 py-3 border-b border-border">
        {CELLS.map((cell) => (
          <Skeleton.Box key={cell.key} width={cell.width} height={10} blend />
        ))}
      </View>
      {keys.map((row, index) => (
        <View
          key={row}
          className={`flex-row gap-4 px-3 py-3.5 ${index === keys.length - 1 ? '' : 'border-b border-border'}`}
        >
          {CELLS.map((cell) => (
            <Skeleton.Box key={cell.key} width={cell.width} height={12} />
          ))}
        </View>
      ))}
    </View>
  );
}

function TileBones() {
  return (
    <View className="flex-row flex-wrap gap-4">
      {[0, 1, 2, 3].map((tile) => (
        <View key={tile} className="flex-1 min-w-40 gap-3 rounded-2xl border border-border p-4">
          <Skeleton.Box width="50%" height={10} />
          <Skeleton.Box width="70%" height={22} />
        </View>
      ))}
    </View>
  );
}

function DetailBones() {
  return (
    <View className="gap-6">
      <View className="gap-3">
        <Skeleton.Box width={220} height={28} />
        <Skeleton.Box width={320} height={12} />
      </View>
      <View className="flex-row flex-wrap gap-6">
        <View className="gap-4" style={{ flexGrow: 999, flexBasis: 480, minWidth: 0 }}>
          <Skeleton.Box width="100%" height={160} borderRadius={16} />
          <Skeleton.Box width="100%" height={120} borderRadius={16} />
        </View>
        <View className="gap-3" style={{ flexGrow: 1, flexBasis: 280 }}>
          {[0, 1, 2, 3, 4].map((row) => (
            <View key={row} className="gap-1.5">
              <Skeleton.Box width="40%" height={10} />
              <Skeleton.Box width="80%" height={12} />
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

function FormBones({ rows }: { rows: number }) {
  return (
    <View className="gap-5 rounded-2xl border border-border p-4 md:p-6">
      {ROW_KEYS.slice(0, Math.max(1, Math.min(rows, 5))).map((row) => (
        <View key={row} className="gap-2">
          <Skeleton.Box width={140} height={10} />
          <Skeleton.Box width="100%" height={36} />
        </View>
      ))}
    </View>
  );
}
