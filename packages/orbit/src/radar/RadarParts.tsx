import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import type {
  PaymentIntent,
  RadarEvaluation,
  RadarRuleAction,
  Review,
} from '@peable.to/shared-types';
import { Badge } from '@oxy.so/bloom/badge';
import { LinkButton } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import type { DashboardScope } from '../api/dashboard';
import { formatInstant } from '../format/time';
import { labelFor, t } from '../i18n';
import { ErrorNotice, PageSkeleton } from '../ui/states';
import { Section } from '../ui/OrbitScreen';
import { ToneBadge } from '../ui/StatusBadge';
import { decisionTone, evaluationFacts, reviewTone } from './reviews';
import { factAvailability, factType, RADAR_FACT_NAMES, type RadarFact } from './ruleForm';
import { usePaymentEvaluations } from './useRadar';

const ACTION_TONES: Record<RadarRuleAction, 'success' | 'danger' | 'warning'> = {
  allow: 'success',
  block: 'danger',
  review: 'warning',
};

export function ruleActionLabel(action: RadarRuleAction): string {
  return labelFor('radar.action', action);
}

export function RuleActionBadge({ action }: { action: RadarRuleAction }) {
  return (
    <Badge
      appearance="subtle"
      tone={ACTION_TONES[action] ?? 'neutral'}
      size="label-small"
      content={ruleActionLabel(action)}
    />
  );
}

/** A predicate as written: monospace, selectable, never reflowed into prose. */
export function Predicate({ text, lines }: { text: string; lines?: number }) {
  return (
    <Text variant="body-2-regular" selectable numberOfLines={lines} className="font-mono">
      {text}
    </Text>
  );
}

/** Open, or why it closed. */
export function reviewStatusLabel(review: Pick<Review, 'open' | 'closed_reason'>): string {
  if (review.open) return t('review.status.open');
  return review.closed_reason
    ? labelFor('review.closedReason', review.closed_reason)
    : t('review.status.closed');
}

export function ReviewStatusBadge({ review }: { review: Pick<Review, 'open' | 'closed_reason'> }) {
  return <ToneBadge tone={reviewTone(review)} label={reviewStatusLabel(review)} />;
}

/** A link to the payment detail screen. */
export function PaymentLink({ id }: { id: string }) {
  const router = useRouter();
  return (
    <LinkButton
      size="sm"
      accessibilityLabel={`${t('payment.title')} ${id}`}
      onPress={() => router.push({ pathname: '/payments/[id]', params: { id } })}
    >
      {id}
    </LinkButton>
  );
}

/** A link to a rule's own page (it may have been deleted since; its page says so). */
export function RuleLink({ id, version }: { id: string; version: number }) {
  const router = useRouter();
  return (
    <LinkButton
      size="sm"
      accessibilityLabel={`${t('radar.rule.title')} ${id}`}
      onPress={() => router.push({ pathname: '/radar/[id]', params: { id } })}
    >
      {t('radar.ruleVersion', { id, version })}
    </LinkButton>
  );
}

function factAvailabilityLabel(fact: RadarFact): string {
  return t(`radar.availability.${factAvailability(fact)}`);
}

/**
 * Every fact a predicate may name, its type and when it is known. Pressing a
 * name writes `:name:` into the predicate when the editor offers it.
 */
export function FactReference({ onInsert }: { onInsert?: (fact: RadarFact) => void }) {
  return (
    <Section title={t('radar.facts.title')} description={t('radar.facts.body')}>
      {RADAR_FACT_NAMES.map((fact) => (
        <View
          key={fact}
          className="flex-row flex-wrap items-center gap-x-3 gap-y-1 py-1.5 border-b border-border"
        >
          {onInsert ? (
            <LinkButton
              size="sm"
              accessibilityLabel={t('radar.facts.insert', { fact })}
              onPress={() => onInsert(fact)}
            >
              {`:${fact}:`}
            </LinkButton>
          ) : (
            <Text variant="body-2-regular" selectable className="font-mono">
              {`:${fact}:`}
            </Text>
          )}
          <Text variant="caption-1-regular" className="text-muted-foreground">
            {t(`radar.factType.${factType(fact)}`)}
          </Text>
          <Text variant="caption-1-regular" className="text-muted-foreground">
            {factAvailabilityLabel(fact)}
          </Text>
        </View>
      ))}
      <Text variant="caption-1-regular" className="text-muted-foreground">
        {t('radar.facts.syntax')}
      </Text>
    </Section>
  );
}

/** One fact's value as the gateway recorded it; `null` is unknown, never empty or zero. */
export function FactValues({ facts }: { facts: Array<[string, string | null]> }) {
  if (!facts.length) return null;
  return (
    <View className="gap-0.5">
      {facts.map(([name, value]) => (
        <Text
          key={name}
          variant="caption-1-regular"
          selectable
          className="font-mono text-muted-foreground"
        >
          {value === null
            ? t('radar.fact.unknown', { name })
            : t('radar.fact.value', { name, value })}
        </Text>
      ))}
    </View>
  );
}

function EvaluationRow({ evaluation }: { evaluation: RadarEvaluation }) {
  return (
    <View className="gap-1.5 py-3 border-b border-border">
      <View className="flex-row flex-wrap items-center gap-2">
        <ToneBadge
          tone={decisionTone(evaluation.decision)}
          label={labelFor('radar.decision', evaluation.decision)}
        />
        <Text variant="caption-1-medium" className="text-muted-foreground">
          {labelFor('radar.phase', evaluation.phase)}
        </Text>
        <Text variant="caption-1-regular" className="text-muted-foreground">
          {formatInstant(evaluation.created)}
        </Text>
      </View>
      <Predicate text={evaluation.rule.predicate} />
      <RuleLink id={evaluation.rule.id} version={evaluation.rule.version} />
      <FactValues facts={evaluationFacts(evaluation)} />
    </View>
  );
}

/**
 * A card payment's risk: the review a rule opened, and every evaluation in
 * which a rule matched — the rule as it was, the decision, the phase and the
 * facts it read. What makes a decline explainable.
 */
export function PaymentRisk({ scope, payment }: { scope: DashboardScope; payment: PaymentIntent }) {
  const router = useRouter();
  const query = usePaymentEvaluations(scope, payment.id);
  const reviewId = payment.review
    ? typeof payment.review === 'string'
      ? payment.review
      : payment.review.id
    : null;
  let body: ReactNode;
  if (query.isPending) {
    body = <PageSkeleton variant="table" rows={2} accessibilityLabel={t('radar.payment.title')} />;
  } else if (query.isError) {
    body = <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />;
  } else if (!query.data.data.length) {
    body = (
      <Text variant="body-2-regular" className="text-muted-foreground">
        {t('radar.payment.none')}
      </Text>
    );
  } else {
    body = query.data.data.map((evaluation) => (
      <EvaluationRow key={evaluation.id} evaluation={evaluation} />
    ));
  }
  return (
    <Section title={t('radar.payment.title')} description={t('radar.payment.body')}>
      {reviewId ? (
        <View className="flex-row flex-wrap items-center gap-2 pb-2">
          <Text variant="body-2-medium">{t('radar.payment.review')}</Text>
          <LinkButton
            size="sm"
            accessibilityLabel={`${t('review.title')} ${reviewId}`}
            onPress={() => router.push({ pathname: '/reviews/[id]', params: { id: reviewId } })}
          >
            {reviewId}
          </LinkButton>
        </View>
      ) : null}
      {body}
    </Section>
  );
}
