import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  CreateRadarRuleParams,
  RadarRule,
  UpdateRadarRuleParams,
} from '@peable.to/shared-types';
import { Admonition, AdmonitionText } from '@oxy.so/bloom/admonition';
import { Button } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '../api/client';
import type { DashboardScope } from '../api/dashboard';
import { describeError, isOrbitApiError } from '../api/transport';
import { formatAmount } from '../format/money';
import { formatInstant } from '../format/time';
import { t } from '../i18n';
import { useDashboardPermissions } from '../scope/useDashboardPermissions';
import { Choice } from '../ui/Choice';
import { FormField } from '../ui/FormField';
import { DetailLayout, Section } from '../ui/OrbitScreen';
import { ErrorNotice, PermissionNotice } from '../ui/states';
import { Toggle } from '../ui/Toggle';
import { FactReference, FactValues, PaymentLink, ruleActionLabel } from './RadarParts';
import {
  buildCreateRuleBody,
  buildUpdateRuleBody,
  changesVersion,
  EMPTY_RULE_FORM,
  type PredicateProblem,
  type PredicateStatus,
  parsePredicateRefusal,
  predicateStatus,
  RADAR_LIMITS,
  RADAR_RULE_ACTIONS,
  type RadarFact,
  type RadarRuleAction,
  type RuleForm,
  type RuleFormErrors,
  ruleFormOf,
  ruleSaveFailure,
  ruleUnchanged,
  ruleTiming,
  splitAtPosition,
  timingNoteKeys,
} from './ruleForm';
import { radarKeys, usePredicateCheck } from './useRadar';

/** The predicate with the character the gateway stopped at marked. */
function Pointer({ predicate, problem }: { predicate: string; problem: PredicateProblem }) {
  if (problem.position === null) return null;
  const { before, at, after } = splitAtPosition(predicate, problem.position);
  return (
    <Text variant="caption-1-regular" selectable className="font-mono">
      {before}
      <Text variant="caption-1-semibold" className="font-mono text-destructive underline">
        {at || t('radar.predicate.end')}
      </Text>
      {after}
    </Text>
  );
}

function StatusLine({
  status,
  predicate,
  checkError,
}: {
  status: PredicateStatus;
  predicate: string;
  checkError: unknown;
}) {
  switch (status.kind) {
    case 'empty':
      return (
        <Text variant="caption-1-regular" className="text-muted-foreground">
          {t('radar.predicate.empty')}
        </Text>
      );
    case 'checking':
      return (
        <Text variant="caption-1-regular" className="text-muted-foreground">
          {t('radar.predicate.checking')}
        </Text>
      );
    case 'valid':
      return (
        <Text variant="caption-1-regular" className="text-success-text">
          {status.facts.length
            ? t('radar.predicate.valid', { facts: status.facts.join(', ') })
            : t('radar.predicate.validNoFacts')}
        </Text>
      );
    case 'invalid':
      return (
        <View className="gap-1" accessibilityRole="alert">
          <Text variant="caption-1-medium" className="text-destructive">
            {status.problem.position === null
              ? t('radar.predicate.invalid', { reason: status.problem.message })
              : t('radar.predicate.invalidAt', {
                  reason: status.problem.message,
                  position: status.problem.position + 1,
                })}
          </Text>
          <Pointer predicate={predicate} problem={status.problem} />
        </View>
      );
    case 'unchecked':
      return (
        <Text variant="caption-1-regular" className="text-muted-foreground">
          {t('radar.predicate.unchecked', {
            reason: describeError(checkError, t('error.generic')),
          })}
        </Text>
      );
  }
}

/** When this rule can act, and what its action does then. Shown once the predicate is valid. */
function TimingNote({
  action,
  facts,
  postAuthorizationOnly,
}: {
  action: RadarRuleAction;
  facts: RadarFact[];
  postAuthorizationOnly: boolean;
}) {
  const timing = ruleTiming(facts, postAuthorizationOnly);
  const keys = timingNoteKeys(action, timing);
  const warn = action === 'block' && timing !== 'before';
  return (
    <Admonition type={warn ? 'warning' : 'info'}>
      <AdmonitionText>{keys.map((key) => t(key)).join(' ')}</AdmonitionText>
    </Admonition>
  );
}

/** "Test against recent payments": the predicate, unsaved, judged by the gateway. Read-only. */
function RulePreview({
  scope,
  predicate,
  ready,
}: {
  scope: DashboardScope;
  predicate: string;
  ready: boolean;
}) {
  const preview = useMutation({
    mutationFn: (text: string) => dashboardApi.radar.rules.preview(scope, text),
  });
  const refused =
    preview.isError && isOrbitApiError(preview.error) && preview.error.param === 'predicate'
      ? parsePredicateRefusal(preview.error.message)
      : null;
  return (
    <Section
      title={t('radar.preview.title')}
      description={t('radar.preview.body', { count: RADAR_LIMITS.previewPaymentsMax })}
      actions={
        <Button
          appearance="outline"
          size="sm"
          loading={preview.isPending}
          disabled={!ready || preview.isPending}
          onPress={() => preview.mutate(predicate.trim())}
        >
          {t('radar.preview.run')}
        </Button>
      }
    >
      {!ready ? (
        <Text variant="caption-1-regular" className="text-muted-foreground">
          {t('radar.preview.needsValid')}
        </Text>
      ) : null}
      {refused ? (
        <Text variant="caption-1-medium" className="text-destructive">
          {t('radar.predicate.invalid', { reason: refused.message })}
        </Text>
      ) : preview.isError ? (
        <ErrorNotice error={preview.error} onRetry={() => preview.mutate(predicate.trim())} />
      ) : null}
      {preview.data ? (
        <View className="gap-1">
          <Text variant="body-2-medium">
            {preview.data.evaluated === 0
              ? t('radar.preview.noPayments')
              : t('radar.preview.result', {
                  matched: preview.data.matched.length,
                  evaluated: preview.data.evaluated,
                })}
          </Text>
          <Text variant="caption-1-regular" className="text-muted-foreground">
            {t('radar.preview.velocityNote')}
          </Text>
          {preview.data.matched.map((match) => (
            <View
              key={match.payment_intent}
              className="flex-row flex-wrap items-start gap-x-4 gap-y-1 py-2 border-b border-border"
            >
              <PaymentLink id={match.payment_intent} />
              <Text variant="body-2-regular">{formatAmount(match.amount, match.currency)}</Text>
              <Text variant="caption-1-regular" className="text-muted-foreground">
                {formatInstant(match.created)}
              </Text>
              <FactValues
                facts={Object.entries(match.facts).sort(([a], [b]) => a.localeCompare(b))}
              />
            </View>
          ))}
        </View>
      ) : null}
    </Section>
  );
}

const errorHint = (errors: RuleFormErrors, field: keyof RuleFormErrors, fallback?: string) =>
  errors[field] ? t(`radar.error.${errors[field]}`, { max: limitOf(field) }) : fallback;

function limitOf(field: keyof RuleFormErrors): number {
  return field === 'predicate' ? RADAR_LIMITS.predicateMax : RADAR_LIMITS.descriptionMax;
}

/**
 * Create a rule (no `rule`), or edit one. Writing rules is `money`; checking
 * the predicate and testing it against recent payments are reads, so a person
 * who cannot save can still try a condition out.
 */
export function RuleEditor({ scope, rule }: { scope: DashboardScope; rule?: RadarRule }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const permitted = useDashboardPermissions().can('money');
  const [form, setForm] = useState<RuleForm>(() => (rule ? ruleFormOf(rule) : EMPTY_RULE_FORM));
  const [errors, setErrors] = useState<RuleFormErrors>({});
  const [serverProblem, setServerProblem] = useState<PredicateProblem | null>(null);
  const [limitReached, setLimitReached] = useState(false);
  const { checked, query } = usePredicateCheck(scope, form.predicate);
  const status = predicateStatus({
    typed: form.predicate,
    checked,
    answer: query.data,
    failed: query.isError,
  });

  const set = <K extends keyof RuleForm>(field: K, value: RuleForm[K]) => {
    setForm((prior) => ({ ...prior, [field]: value }));
    if (field === 'predicate' || field === 'description') {
      setErrors((prior) => ({ ...prior, [field]: undefined }));
    }
    if (field === 'predicate') setServerProblem(null);
  };

  const save = useMutation({
    mutationFn: (body: CreateRadarRuleParams | UpdateRadarRuleParams): Promise<RadarRule> =>
      rule
        ? dashboardApi.radar.rules.update(scope, rule.id, body)
        : dashboardApi.radar.rules.create(scope, body as CreateRadarRuleParams),
    onSuccess: (saved) => {
      queryClient.setQueryData(radarKeys.rule(scope, saved.id), saved);
      void queryClient.invalidateQueries({ queryKey: [...radarKeys.all(scope), 'rules'] });
      toast.success(t(rule ? 'radar.form.saved' : 'radar.form.created'));
      if (!rule) router.replace({ pathname: '/radar/[id]', params: { id: saved.id } });
    },
    onError: (error) => {
      const failure = ruleSaveFailure(error);
      if (failure.kind === 'predicate') {
        setServerProblem(failure.problem);
        setErrors({ predicate: 'server' });
        toast.error(t('radar.form.fixErrors'));
        return;
      }
      if (failure.kind === 'limit') {
        setLimitReached(true);
        toast.error(t('radar.error.limit', { max: RADAR_LIMITS.rulesPerMerchantMax }));
        return;
      }
      if (failure.kind === 'field') setErrors({ [failure.field]: 'server' });
      toast.error(describeError(error, t('error.generic')));
    },
  });

  const submit = () => {
    const built = rule ? buildUpdateRuleBody(rule, form) : buildCreateRuleBody(form);
    if (!built.ok) {
      setErrors(built.errors);
      toast.error(t('radar.form.fixErrors'));
      return;
    }
    save.mutate(built.body);
  };

  const locked = !permitted || save.isPending;
  const shown: PredicateStatus = serverProblem
    ? { kind: 'invalid', problem: serverProblem }
    : status;
  const unchanged = rule !== undefined && ruleUnchanged(rule, form);

  const insert = (fact: RadarFact) => {
    const prior = form.predicate.trimEnd();
    set('predicate', `${prior}${prior ? ' ' : ''}:${fact}: `);
  };

  return (
    <DetailLayout aside={<FactReference onInsert={permitted ? insert : undefined} />}>
      {!permitted ? <PermissionNotice action="money" /> : null}
      {limitReached ? (
        <Admonition type="warning">
          <AdmonitionText>
            {t('radar.error.limit', { max: RADAR_LIMITS.rulesPerMerchantMax })}
          </AdmonitionText>
        </Admonition>
      ) : null}

      <Section title={t('radar.form.action')} description={t('radar.precedence')}>
        <View className="w-72">
          <Choice
            label={t('radar.form.action')}
            value={form.action}
            options={RADAR_RULE_ACTIONS.map((action) => ({
              value: action,
              label: ruleActionLabel(action),
            }))}
            onChange={(value) => set('action', value as RadarRuleAction)}
            disabled={locked}
          />
        </View>
        <Text variant="caption-1-regular" className="text-muted-foreground">
          {t(`radar.actionHelp.${form.action}`)}
        </Text>
      </Section>

      <Section title={t('radar.form.predicate')} description={t('radar.form.predicateHelp')}>
        <FormField
          label={t('radar.form.predicate')}
          value={form.predicate}
          onChange={(value) => set('predicate', value)}
          placeholder=":amount: > 100000 and :card_country: not in ('US', 'CA')"
          multiline
          invalid={shown.kind === 'invalid' || Boolean(errors.predicate)}
          hint={
            errors.predicate && errors.predicate !== 'server'
              ? errorHint(errors, 'predicate')
              : undefined
          }
          disabled={!permitted}
        />
        <StatusLine status={shown} predicate={form.predicate} checkError={query.error} />
        {shown.kind === 'valid' ? (
          <TimingNote
            action={form.action}
            facts={shown.facts}
            postAuthorizationOnly={shown.postAuthorizationOnly}
          />
        ) : null}
      </Section>

      <Section title={t('radar.form.details')}>
        <FormField
          label={t('radar.form.description')}
          value={form.description}
          onChange={(value) => set('description', value)}
          hint={errorHint(errors, 'description', t('radar.form.descriptionHint'))}
          invalid={Boolean(errors.description)}
          autoCapitalize="sentences"
          disabled={locked}
        />
        <Toggle
          label={t('radar.form.enabled')}
          hint={t('radar.form.enabledHint')}
          value={form.enabled}
          onChange={(value) => set('enabled', value)}
          disabled={locked}
        />
        {rule && changesVersion(rule, form) ? (
          <Text variant="caption-1-regular" className="text-muted-foreground">
            {t('radar.form.newVersion', { version: rule.version + 1 })}
          </Text>
        ) : null}
        {permitted ? (
          <View className="flex-row justify-end">
            <Button
              appearance="solid"
              tone="accent"
              loading={save.isPending}
              disabled={locked || unchanged || shown.kind === 'invalid'}
              onPress={submit}
            >
              {t(rule ? 'radar.form.save' : 'radar.form.create')}
            </Button>
          </View>
        ) : null}
      </Section>

      <RulePreview scope={scope} predicate={form.predicate} ready={status.kind === 'valid'} />
    </DetailLayout>
  );
}
