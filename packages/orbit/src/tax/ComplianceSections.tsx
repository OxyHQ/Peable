import { useState } from 'react';
import { View } from 'react-native';
import {
  TAX_CUSTOMER_TYPES,
  TAX_DOCUMENT_KINDS,
  TAX_LEGAL_ENTITY_TYPES,
  TAX_OPERATING_LOCATION_KINDS,
  TAX_REGISTRATION_DECLARATION_STATUSES,
  TAX_REGISTRATION_SCHEMES,
  TAX_REVIEW_DECISIONS,
  type TaxAssessmentReplay,
  type TaxCustomerType,
  type TaxDocumentKind,
  type TaxLegalEntityType,
  type TaxOperatingLocationKind,
  type TaxRegistrationDeclarationStatus,
  type TaxRegistrationScheme,
  type TaxReviewDecision,
  type TaxReviewItem,
} from '@peable.to/shared-types/tax';
import type { FileObject } from '@peable.to/shared-types';
import { Admonition, AdmonitionText } from '@oxy.so/bloom/admonition';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Text } from '@oxy.so/bloom/typography';
import { taxComplianceApi } from '../api/client';
import type { DashboardScope } from '../api/dashboard';
import { formatSignedAmount } from '../format/money';
import { formatInstant, nowSeconds } from '../format/time';
import { t } from '../i18n';
import { Choice } from '../ui/Choice';
import { FileUploadField } from '../ui/FileUploadField';
import { FormField } from '../ui/FormField';
import { ErrorNotice, Field, Section } from '../ui/OrbitScreen';
import { useCompliance, useComplianceWrite, useReviewItems } from './useCompliance';
import {
  capabilityTone,
  checklistTone,
  countryCode,
  deadlineTone,
  declarationTone,
  formatDay,
  outcomeLabel,
  outcomeTone,
  parseDay,
  placeLabel,
  reviewTone,
  stateCode,
  type Tone,
} from './vocabulary';
import { PageSkeleton } from '../ui/states';

function Tag({ tone, label }: { tone: Tone; label: string }) {
  return <Badge appearance="subtle" tone={tone} size="label-small" content={label} />;
}

function Muted({ children }: { children: string }) {
  return (
    <Text variant="caption-1-regular" className="text-muted-foreground">
      {children}
    </Text>
  );
}

const options = (values: readonly string[], prefix: string) =>
  values.map((value) => ({ value, label: t(`${prefix}.${value}`) }));

function Row({ children }: { children: React.ReactNode }) {
  return (
    <View className="flex-row flex-wrap items-center justify-between gap-2 py-3 border-b border-border">
      {children}
    </View>
  );
}

function Fields({ children }: { children: React.ReactNode }) {
  return <View className="flex-row flex-wrap gap-4">{children}</View>;
}
function Cell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return <View className={wide ? 'flex-1 min-w-56' : 'flex-1 min-w-40'}>{children}</View>;
}

// ── Overview ─────────────────────────────────────────────────────────────────

export function OverviewSection({ scope }: { scope: DashboardScope }) {
  const assessments = useCompliance(scope, 'assessments');
  const capabilities = useCompliance(scope, 'capabilities');
  const ruleSet = useCompliance(scope, 'ruleSet');
  const review = useReviewItems(scope);
  const [replay, setReplay] = useState<TaxAssessmentReplay | null>(null);
  const assess = useComplianceWrite(scope, () => taxComplianceApi.assess(scope));
  const check = useComplianceWrite(scope, async (assessmentId: string) => {
    setReplay(await taxComplianceApi.replay(scope, assessmentId));
  });

  if (assessments.error)
    return <ErrorNotice error={assessments.error} onRetry={assessments.refetch} />;
  if (!assessments.data || !capabilities.data || !ruleSet.data)
    return <PageSkeleton variant="table" accessibilityLabel={t('compliance.section.overview')} />;
  const latest = assessments.data.data[0];
  const open = (review.data?.data ?? []).filter((item) => item.status === 'open').length;

  return (
    <View className="gap-6">
      <Admonition type="warning">
        <AdmonitionText>{t('compliance.unreviewedRules')}</AdmonitionText>
      </Admonition>
      <Section
        title={t('compliance.overview.assessment')}
        actions={
          <View className="flex-row gap-2">
            {latest ? (
              <Button
                appearance="outline"
                size="sm"
                loading={check.isPending}
                onPress={() => check.mutate(latest.id)}
              >
                {t('compliance.overview.replay')}
              </Button>
            ) : null}
            <Button
              appearance="solid"
              tone="accent"
              size="sm"
              loading={assess.isPending}
              onPress={() => assess.mutate(undefined)}
            >
              {t('compliance.overview.run')}
            </Button>
          </View>
        }
      >
        {latest ? (
          <Muted>
            {t('compliance.overview.ran', {
              at: formatInstant(latest.created),
              version: latest.rule_set_version,
            })}
          </Muted>
        ) : (
          <Muted>{t('compliance.overview.none')}</Muted>
        )}
        {replay ? (
          <Admonition type={replay.matches ? 'info' : 'error'}>
            <AdmonitionText>
              {replay.matches
                ? t('compliance.overview.replayMatches', { version: replay.rule_set_version })
                : t('compliance.overview.replayDiffers')}
            </AdmonitionText>
          </Admonition>
        ) : null}
        <Muted>{t('compliance.overview.openItems', { count: open })}</Muted>
      </Section>

      {latest ? (
        <Section title={t('compliance.overview.jurisdictions')}>
          {latest.results.map((result) => (
            <View
              key={`${result.rule}-${result.country}-${result.state}`}
              className="gap-1 py-3 border-b border-border"
            >
              <View className="flex-row flex-wrap items-center gap-2">
                <Tag tone={outcomeTone(result.outcome)} label={outcomeLabel(result.outcome)} />
                <Text variant="body-2-semibold">
                  {`${placeLabel(result.country, result.state)}${result.tax_type ? ` · ${result.tax_type === 'vat' ? 'VAT' : 'sales tax'}` : ''}`}
                </Text>
              </View>
              {result.measured ? (
                <Muted>
                  {result.threshold
                    ? t('compliance.overview.measured', {
                        amount: formatSignedAmount(
                          result.measured.amount,
                          result.measured.currency,
                        ),
                        threshold: formatSignedAmount(
                          result.threshold.amount,
                          result.threshold.currency,
                        ),
                        transactions: result.measured.transactions,
                      })
                    : t('compliance.overview.measuredNoThreshold', {
                        amount: formatSignedAmount(
                          result.measured.amount,
                          result.measured.currency,
                        ),
                        transactions: result.measured.transactions,
                      })}
                </Muted>
              ) : null}
              {result.measured?.excluded_currencies.length ? (
                <Muted>
                  {t('compliance.overview.excluded', {
                    currencies: result.measured.excluded_currencies.join(', '),
                  })}
                </Muted>
              ) : null}
              {result.deadline ? (
                <Muted>
                  {t('compliance.overview.deadline', { due: formatDay(result.deadline.due) })}
                </Muted>
              ) : null}
              {result.reasons.map((reason) => (
                <Text key={reason.code} variant="body-2-regular">
                  {reason.message}
                </Text>
              ))}
              <Muted>
                {`${t('compliance.overview.coverage')}: ${result.coverage_limits.map((limit) => limit.message).join(' ')}`}
              </Muted>
            </View>
          ))}
        </Section>
      ) : null}

      <Section title={t('compliance.overview.supported')}>
        {ruleSet.data.rules.map((rule) => (
          <View key={rule.id} className="gap-1 py-2 border-b border-border">
            <Text variant="body-2-semibold">{rule.name}</Text>
            <Muted>{`${t('compliance.overview.sources')}: ${rule.sources.map((source) => `${source.publisher} — ${source.url}`).join(' · ')}`}</Muted>
          </View>
        ))}
        <Muted>{ruleSet.data.unsupported}</Muted>
      </Section>

      <Section title={t('compliance.overview.capabilities')}>
        {capabilities.data.capabilities.map((capability) => (
          <Row key={capability.id}>
            <View className="gap-0.5 flex-1 min-w-56">
              <Text variant="body-2-semibold">{capability.id.replaceAll('_', ' ')}</Text>
              <Muted>{`${t(`compliance.category.${capability.category}`)} · ${capability.reason}`}</Muted>
            </View>
            <Tag
              tone={capabilityTone(capability.status)}
              label={t(`compliance.capability.${capability.status}`)}
            />
          </Row>
        ))}
      </Section>
    </View>
  );
}

// ── Business ─────────────────────────────────────────────────────────────────

export function BusinessSection({ scope }: { scope: DashboardScope }) {
  const profile = useCompliance(scope, 'profile');
  const locations = useCompliance(scope, 'locations');
  const destinations = useCompliance(scope, 'destinations');
  const [draft, setDraft] = useState<{
    entity: TaxLegalEntityType | null;
    customers: TaxCustomerType | null;
    country: string | null;
    state: string | null;
    month: string | null;
  }>({ entity: null, customers: null, country: null, state: null, month: null });
  const [location, setLocation] = useState<{
    kind: TaxOperatingLocationKind;
    country: string;
    state: string;
  }>({
    kind: 'head_office',
    country: '',
    state: '',
  });
  const [destination, setDestination] = useState({
    country: '',
    state: '',
    customers: 'consumers' as TaxCustomerType,
  });

  const save = useComplianceWrite(scope, () => {
    const current = profile.data;
    const month = (draft.month ?? String(current?.fiscal_year_end_month ?? '')).trim();
    return taxComplianceApi.updateProfile(scope, {
      entity_type: draft.entity ?? current?.entity_type,
      customer_types: draft.customers ?? current?.customer_types,
      incorporation_country: countryCode(draft.country ?? current?.incorporation_country ?? ''),
      incorporation_state: stateCode(draft.state ?? current?.incorporation_state ?? ''),
      fiscal_year_end_month: month ? Number(month) : null,
    });
  });
  const addLocation = useComplianceWrite(scope, () =>
    taxComplianceApi.addLocation(scope, {
      kind: location.kind,
      country: countryCode(location.country) ?? location.country,
      state: stateCode(location.state),
    }),
  );
  const endLocation = useComplianceWrite(scope, (locationId: string) =>
    taxComplianceApi.updateLocation(scope, locationId, { ended: nowSeconds() }),
  );
  const addDestination = useComplianceWrite(scope, () =>
    taxComplianceApi.addDestination(scope, {
      country: countryCode(destination.country) ?? destination.country,
      state: stateCode(destination.state),
      customer_types: destination.customers,
    }),
  );

  if (profile.error) return <ErrorNotice error={profile.error} onRetry={profile.refetch} />;
  if (!profile.data)
    return <PageSkeleton variant="table" accessibilityLabel={t('compliance.section.business')} />;
  const busy =
    save.isPending || addLocation.isPending || addDestination.isPending || endLocation.isPending;

  return (
    <View className="gap-6">
      <Section title={t('compliance.business.entity')}>
        {profile.data.missing.length ? (
          <Admonition type="warning">
            <AdmonitionText>
              {t('compliance.business.missing', { fields: profile.data.missing.join(', ') })}
            </AdmonitionText>
          </Admonition>
        ) : (
          <Muted>{t('compliance.business.complete')}</Muted>
        )}
        <Field label={t('compliance.business.legalName')} value={profile.data.legal_name ?? '—'} />
        <Muted>{t('compliance.business.legalNameHelp')}</Muted>
        <Fields>
          <Cell wide>
            <Choice
              label={t('compliance.business.entityType')}
              value={draft.entity ?? profile.data.entity_type}
              options={options(TAX_LEGAL_ENTITY_TYPES, 'compliance.entity')}
              onChange={(value) =>
                setDraft((prior) => ({ ...prior, entity: value as TaxLegalEntityType }))
              }
              disabled={busy}
            />
          </Cell>
          <Cell wide>
            <Choice
              label={t('compliance.business.customers')}
              value={draft.customers ?? profile.data.customer_types}
              options={options(TAX_CUSTOMER_TYPES, 'compliance.customers')}
              onChange={(value) =>
                setDraft((prior) => ({ ...prior, customers: value as TaxCustomerType }))
              }
              disabled={busy}
            />
          </Cell>
        </Fields>
        <Fields>
          <Cell>
            <FormField
              label={t('compliance.business.incorporationCountry')}
              value={draft.country ?? profile.data.incorporation_country ?? ''}
              onChange={(value) => setDraft((prior) => ({ ...prior, country: value }))}
              autoCapitalize="characters"
              disabled={busy}
            />
          </Cell>
          <Cell>
            <FormField
              label={t('compliance.business.incorporationState')}
              value={draft.state ?? profile.data.incorporation_state ?? ''}
              onChange={(value) => setDraft((prior) => ({ ...prior, state: value }))}
              autoCapitalize="characters"
              disabled={busy}
            />
          </Cell>
          <Cell>
            <FormField
              label={t('compliance.business.fiscalMonth')}
              value={draft.month ?? String(profile.data.fiscal_year_end_month ?? '')}
              onChange={(value) => setDraft((prior) => ({ ...prior, month: value }))}
              disabled={busy}
            />
          </Cell>
        </Fields>
        <Muted>{t('compliance.business.incorporationHelp')}</Muted>
        <View className="flex-row justify-end">
          <Button
            appearance="solid"
            tone="accent"
            loading={save.isPending}
            disabled={busy}
            onPress={() => save.mutate(undefined)}
          >
            {t('compliance.business.save')}
          </Button>
        </View>
      </Section>

      <Section
        title={t('compliance.business.locations')}
        description={t('compliance.business.locationsHelp')}
      >
        {(locations.data?.data ?? []).length === 0 ? (
          <Muted>{t('compliance.business.none')}</Muted>
        ) : null}
        {(locations.data?.data ?? []).map((row) => (
          <Row key={row.id}>
            <View className="gap-0.5 flex-1 min-w-56">
              <Text variant="body-2-semibold">{`${placeLabel(row.country, row.state)} · ${t(`compliance.locationKind.${row.kind}`)}`}</Text>
              {row.ended ? (
                <Muted>{t('compliance.business.ended', { at: formatDay(row.ended) })}</Muted>
              ) : null}
            </View>
            {row.ended ? null : (
              <Button
                appearance="outline"
                size="sm"
                disabled={busy}
                onPress={() => endLocation.mutate(row.id)}
              >
                {t('compliance.business.endLocation')}
              </Button>
            )}
          </Row>
        ))}
        <Fields>
          <Cell wide>
            <Choice
              label={t('compliance.business.kind')}
              value={location.kind}
              options={options(TAX_OPERATING_LOCATION_KINDS, 'compliance.locationKind')}
              onChange={(value) =>
                setLocation((prior) => ({ ...prior, kind: value as TaxOperatingLocationKind }))
              }
              disabled={busy}
            />
          </Cell>
          <Cell>
            <FormField
              label={t('compliance.business.country')}
              value={location.country}
              onChange={(value) => setLocation((prior) => ({ ...prior, country: value }))}
              autoCapitalize="characters"
              disabled={busy}
            />
          </Cell>
          <Cell>
            <FormField
              label={t('compliance.business.state')}
              value={location.state}
              onChange={(value) => setLocation((prior) => ({ ...prior, state: value }))}
              autoCapitalize="characters"
              disabled={busy}
            />
          </Cell>
        </Fields>
        <View className="flex-row justify-end">
          <Button
            appearance="outline"
            disabled={busy || !countryCode(location.country)}
            onPress={() =>
              addLocation.mutate(undefined, {
                onSuccess: () => setLocation((prior) => ({ ...prior, country: '', state: '' })),
              })
            }
          >
            {t('compliance.business.addLocation')}
          </Button>
        </View>
      </Section>

      <Section
        title={t('compliance.business.destinations')}
        description={t('compliance.business.destinationsHelp')}
      >
        {(destinations.data?.data ?? []).length === 0 ? (
          <Muted>{t('compliance.business.none')}</Muted>
        ) : null}
        {(destinations.data?.data ?? []).map((row) => (
          <Row key={row.id}>
            <Text variant="body-2-semibold">
              {`${placeLabel(row.country, row.state)} · ${t(`compliance.customers.${row.customer_types}`)}`}
            </Text>
          </Row>
        ))}
        <Fields>
          <Cell>
            <FormField
              label={t('compliance.business.country')}
              value={destination.country}
              onChange={(value) => setDestination((prior) => ({ ...prior, country: value }))}
              autoCapitalize="characters"
              disabled={busy}
            />
          </Cell>
          <Cell>
            <FormField
              label={t('compliance.business.state')}
              value={destination.state}
              onChange={(value) => setDestination((prior) => ({ ...prior, state: value }))}
              autoCapitalize="characters"
              disabled={busy}
            />
          </Cell>
          <Cell wide>
            <Choice
              label={t('compliance.business.customers')}
              value={destination.customers}
              options={options(TAX_CUSTOMER_TYPES, 'compliance.customers')}
              onChange={(value) =>
                setDestination((prior) => ({ ...prior, customers: value as TaxCustomerType }))
              }
              disabled={busy}
            />
          </Cell>
        </Fields>
        <View className="flex-row justify-end">
          <Button
            appearance="outline"
            disabled={busy || !countryCode(destination.country)}
            onPress={() =>
              addDestination.mutate(undefined, {
                onSuccess: () => setDestination((prior) => ({ ...prior, country: '', state: '' })),
              })
            }
          >
            {t('compliance.business.addDestination')}
          </Button>
        </View>
      </Section>
    </View>
  );
}

// ── Registrations ────────────────────────────────────────────────────────────

const NO_SCHEME = 'none';

export function RegistrationsSection({ scope }: { scope: DashboardScope }) {
  const declarations = useCompliance(scope, 'declarations');
  const [form, setForm] = useState({
    country: '',
    state: '',
    status: 'unknown' as TaxRegistrationDeclarationStatus,
    scheme: NO_SCHEME,
    from: '',
    to: '',
  });
  const add = useComplianceWrite(scope, () =>
    taxComplianceApi.addDeclaration(scope, {
      country: countryCode(form.country) ?? form.country,
      state: stateCode(form.state),
      status: form.status,
      scheme: form.scheme === NO_SCHEME ? null : (form.scheme as TaxRegistrationScheme),
      effective_from: parseDay(form.from),
      effective_to: parseDay(form.to),
    }),
  );
  const change = useComplianceWrite(
    scope,
    (args: {
      id: string;
      status: TaxRegistrationDeclarationStatus;
      from: number | null;
      to: number | null;
    }) =>
      taxComplianceApi.updateDeclaration(scope, args.id, {
        status: args.status,
        ...(args.from !== null ? { effective_from: args.from } : {}),
        ...(args.to !== null ? { effective_to: args.to } : {}),
      }),
  );
  const [pending, setPending] = useState<Record<string, TaxRegistrationDeclarationStatus>>({});

  if (declarations.error)
    return <ErrorNotice error={declarations.error} onRetry={declarations.refetch} />;
  if (!declarations.data)
    return (
      <PageSkeleton variant="table" accessibilityLabel={t('compliance.section.registrations')} />
    );
  const busy = add.isPending || change.isPending;
  const statusOptions = options(TAX_REGISTRATION_DECLARATION_STATUSES, 'compliance.status');
  const dated = form.status === 'registered' || form.status === 'ended';

  return (
    <View className="gap-6">
      <Admonition type="info">
        <AdmonitionText>{t('compliance.registrations.submit')}</AdmonitionText>
      </Admonition>
      <Section
        title={t('compliance.registrations.title')}
        description={t('compliance.registrations.help')}
      >
        {declarations.data.data.length === 0 ? (
          <Muted>{t('compliance.business.none')}</Muted>
        ) : null}
        {declarations.data.data.map((row) => (
          <Row key={row.id}>
            <View className="gap-0.5 flex-1 min-w-56">
              <View className="flex-row flex-wrap items-center gap-2">
                <Tag
                  tone={declarationTone(row.status)}
                  label={t(`compliance.status.${row.status}`)}
                />
                <Text variant="body-2-semibold" selectable>
                  {`${placeLabel(row.country, row.state)}${row.scheme ? ` · ${t(`tax.scheme.${row.scheme}`)}` : ''}`}
                </Text>
              </View>
              <Muted>{t('compliance.registrations.unverified')}</Muted>
              <Muted>
                {`${formatDay(row.effective_from)} → ${formatDay(row.effective_to)} · ${
                  row.collection_registration
                    ? t('compliance.registrations.collection', { id: row.collection_registration })
                    : t('compliance.registrations.notCollecting')
                }`}
              </Muted>
            </View>
            <View className="flex-row items-end gap-2 min-w-56">
              <View className="flex-1">
                <Choice
                  label={t('compliance.registrations.status')}
                  value={pending[row.id] ?? row.status}
                  options={statusOptions}
                  onChange={(value) =>
                    setPending((prior) => ({
                      ...prior,
                      [row.id]: value as TaxRegistrationDeclarationStatus,
                    }))
                  }
                  disabled={busy}
                  size="sm"
                />
              </View>
              <Button
                appearance="outline"
                size="sm"
                disabled={busy || !pending[row.id] || pending[row.id] === row.status}
                onPress={() => {
                  const next = pending[row.id];
                  if (!next) return;
                  // Ending a registration needs its end: today, unless the row already has one.
                  change.mutate({
                    id: row.id,
                    status: next,
                    from:
                      next === 'registered' && row.effective_from === null ? nowSeconds() : null,
                    to: next === 'ended' && row.effective_to === null ? nowSeconds() : null,
                  });
                }}
              >
                {t('compliance.registrations.update')}
              </Button>
            </View>
          </Row>
        ))}
        <Fields>
          <Cell>
            <FormField
              label={t('compliance.business.country')}
              value={form.country}
              onChange={(value) => setForm((prior) => ({ ...prior, country: value }))}
              autoCapitalize="characters"
              disabled={busy}
            />
          </Cell>
          <Cell>
            <FormField
              label={t('compliance.business.state')}
              value={form.state}
              onChange={(value) => setForm((prior) => ({ ...prior, state: value }))}
              autoCapitalize="characters"
              disabled={busy}
            />
          </Cell>
          <Cell wide>
            <Choice
              label={t('compliance.registrations.status')}
              value={form.status}
              options={statusOptions}
              onChange={(value) =>
                setForm((prior) => ({
                  ...prior,
                  status: value as TaxRegistrationDeclarationStatus,
                }))
              }
              disabled={busy}
            />
          </Cell>
          <Cell wide>
            <Choice
              label={t('compliance.registrations.scheme')}
              value={form.scheme}
              options={[
                { value: NO_SCHEME, label: t('compliance.registrations.noScheme') },
                ...TAX_REGISTRATION_SCHEMES.map((scheme) => ({
                  value: scheme,
                  label: t(`tax.scheme.${scheme}`),
                })),
              ]}
              onChange={(value) => setForm((prior) => ({ ...prior, scheme: value }))}
              disabled={busy}
            />
          </Cell>
        </Fields>
        {dated ? (
          <Fields>
            <Cell>
              <FormField
                label={t('compliance.registrations.effectiveFrom')}
                value={form.from}
                onChange={(value) => setForm((prior) => ({ ...prior, from: value }))}
                placeholder="2026-01-01"
                disabled={busy}
              />
            </Cell>
            {form.status === 'ended' ? (
              <Cell>
                <FormField
                  label={t('compliance.registrations.effectiveTo')}
                  value={form.to}
                  onChange={(value) => setForm((prior) => ({ ...prior, to: value }))}
                  placeholder="2026-06-30"
                  disabled={busy}
                />
              </Cell>
            ) : null}
          </Fields>
        ) : null}
        <View className="flex-row justify-end">
          <Button
            appearance="outline"
            disabled={busy || !countryCode(form.country) || (dated && parseDay(form.from) === null)}
            onPress={() =>
              add.mutate(undefined, {
                onSuccess: () =>
                  setForm((prior) => ({ ...prior, country: '', state: '', from: '', to: '' })),
              })
            }
          >
            {t('compliance.registrations.add')}
          </Button>
        </View>
      </Section>
    </View>
  );
}

// ── Documents ────────────────────────────────────────────────────────────────

export function DocumentsSection({ scope }: { scope: DashboardScope }) {
  const checklist = useCompliance(scope, 'checklist');
  const documents = useCompliance(scope, 'documents');
  const [uploaded, setUploaded] = useState<FileObject | null>(null);
  const [kind, setKind] = useState<TaxDocumentKind>('registration_certificate');
  const attach = useComplianceWrite(scope, (file: string) =>
    taxComplianceApi.attachDocument(scope, { file, kind }),
  );

  if (checklist.error) return <ErrorNotice error={checklist.error} onRetry={checklist.refetch} />;
  if (!checklist.data || !documents.data)
    return <PageSkeleton variant="table" accessibilityLabel={t('compliance.section.documents')} />;

  return (
    <View className="gap-6">
      <Section
        title={t('compliance.documents.checklist')}
        description={t('compliance.documents.checklistHelp')}
      >
        {checklist.data.items.map((item) => (
          <Row key={item.key}>
            <View className="gap-0.5 flex-1 min-w-56">
              <Text variant="body-2-semibold">
                {`${t(`compliance.document.${item.kind}`)}${item.country ? ` · ${placeLabel(item.country, item.state)}` : ''}`}
              </Text>
              <Muted>{item.reason}</Muted>
            </View>
            <Tag
              tone={checklistTone(item.status)}
              label={t(`compliance.documents.item.${item.status}`)}
            />
          </Row>
        ))}
      </Section>
      <Section title={t('compliance.documents.attached')}>
        {documents.data.data.length === 0 ? <Muted>{t('compliance.business.none')}</Muted> : null}
        {documents.data.data.map((row) => (
          <Row key={row.id}>
            <View className="gap-0.5 flex-1 min-w-56">
              <Text variant="body-2-semibold" selectable>
                {`${t(`compliance.document.${row.kind}`)} · ${row.filename ?? row.file}`}
              </Text>
              <Muted>{formatInstant(row.created)}</Muted>
            </View>
            <Tag
              tone={row.file_status === 'available' ? 'success' : 'danger'}
              label={t(`compliance.file.${row.file_status}`)}
            />
          </Row>
        ))}
        <FileUploadField
          scope={scope}
          purpose="tax_document"
          label={t('compliance.documents.upload')}
          disabled={attach.isPending}
          onUploaded={setUploaded}
        />
        {uploaded ? (
          <View className="gap-3">
            <Muted>
              {t('compliance.documents.ready', { name: uploaded.filename ?? uploaded.id })}
            </Muted>
            <Choice
              label={t('compliance.documents.kind')}
              value={kind}
              options={options(TAX_DOCUMENT_KINDS, 'compliance.document')}
              onChange={(value) => setKind(value as TaxDocumentKind)}
              disabled={attach.isPending}
            />
            <View className="flex-row justify-end">
              <Button
                appearance="solid"
                tone="accent"
                loading={attach.isPending}
                onPress={() => attach.mutate(uploaded.id, { onSuccess: () => setUploaded(null) })}
              >
                {t('compliance.documents.attach')}
              </Button>
            </View>
          </View>
        ) : null}
      </Section>
    </View>
  );
}

// ── Review queue ─────────────────────────────────────────────────────────────

function ReviewRow({ scope, item }: { scope: DashboardScope; item: TaxReviewItem }) {
  const [decision, setDecision] = useState<TaxReviewDecision>('will_register');
  const [note, setNote] = useState('');
  const decide = useComplianceWrite(scope, () =>
    taxComplianceApi.resolveReviewItem(scope, item.id, { decision, note: note.trim() || null }),
  );
  return (
    <View className="gap-2 py-3 border-b border-border">
      <View className="flex-row flex-wrap items-center gap-2">
        <Tag tone={reviewTone(item)} label={t(`compliance.review.severity.${item.severity}`)} />
        <Text variant="body-2-semibold">{placeLabel(item.country, item.state)}</Text>
        <Muted>{item.code}</Muted>
      </View>
      <Text variant="body-2-regular">{item.message}</Text>
      {item.decision ? (
        <Muted>
          {`${t('compliance.review.by', {
            decision: t(`compliance.decision.${item.decision.decision}`),
            user: item.decision.decided_by,
            at: formatInstant(item.decision.decided_at),
          })}${item.decision.note ? ` — ${item.decision.note}` : ''}`}
        </Muted>
      ) : (
        <View className="gap-2">
          <Fields>
            <Cell wide>
              <Choice
                label={t('compliance.review.decision')}
                value={decision}
                options={options(TAX_REVIEW_DECISIONS, 'compliance.decision')}
                onChange={(value) => setDecision(value as TaxReviewDecision)}
                disabled={decide.isPending}
              />
            </Cell>
            <Cell wide>
              <FormField
                label={t('compliance.review.note')}
                value={note}
                onChange={setNote}
                disabled={decide.isPending}
              />
            </Cell>
          </Fields>
          <View className="flex-row justify-end">
            <Button
              appearance="outline"
              size="sm"
              loading={decide.isPending}
              onPress={() => decide.mutate(undefined)}
            >
              {t('compliance.review.record')}
            </Button>
          </View>
        </View>
      )}
    </View>
  );
}

export function ReviewSection({ scope }: { scope: DashboardScope }) {
  const items = useReviewItems(scope);
  if (items.error) return <ErrorNotice error={items.error} onRetry={items.refetch} />;
  if (!items.data)
    return <PageSkeleton variant="table" accessibilityLabel={t('compliance.section.review')} />;
  const open = items.data.data.filter((item) => item.status === 'open');
  const decided = items.data.data.filter((item) => item.status !== 'open');
  return (
    <View className="gap-6">
      <Section
        title={`${t('compliance.review.title')} · ${t('compliance.review.open')}`}
        description={t('compliance.review.help')}
      >
        {open.length === 0 ? (
          <EmptyState variant="compact" title={t('compliance.review.empty')} />
        ) : null}
        {open.map((item) => (
          <ReviewRow key={item.id} scope={scope} item={item} />
        ))}
      </Section>
      {decided.length ? (
        <Section title={t('compliance.review.decided')}>
          {decided.map((item) => (
            <ReviewRow key={item.id} scope={scope} item={item} />
          ))}
        </Section>
      ) : null}
    </View>
  );
}

// ── Deadlines and roadmap ────────────────────────────────────────────────────

export function DeadlinesSection({ scope }: { scope: DashboardScope }) {
  const deadlines = useCompliance(scope, 'deadlines');
  const capabilities = useCompliance(scope, 'capabilities');
  if (deadlines.error) return <ErrorNotice error={deadlines.error} onRetry={deadlines.refetch} />;
  if (!deadlines.data || !capabilities.data)
    return <PageSkeleton variant="table" accessibilityLabel={t('compliance.section.deadlines')} />;
  const roadmap = capabilities.data.capabilities.filter((each) => each.status === 'not_available');
  return (
    <View className="gap-6">
      <Section title={t('compliance.deadlines.title')} description={t('compliance.deadlines.help')}>
        {deadlines.data.data.length === 0 ? <Muted>{t('compliance.deadlines.empty')}</Muted> : null}
        {deadlines.data.data.map((deadline) => (
          <Row key={`${deadline.kind}-${deadline.rule}-${deadline.due}`}>
            <View className="gap-0.5 flex-1 min-w-56">
              <Text variant="body-2-semibold">
                {`${formatDay(deadline.due)} · ${t(`compliance.deadlines.kind.${deadline.kind}`)} · ${placeLabel(deadline.country, deadline.state)}`}
              </Text>
              <Muted>{deadline.description}</Muted>
              {deadline.period_start !== null ? (
                <Muted>
                  {t('compliance.deadlines.period', {
                    from: formatDay(deadline.period_start),
                    to: formatDay(deadline.period_end),
                  })}
                </Muted>
              ) : null}
              <Muted>{`${t('compliance.deadlines.notTracked')} · ${deadline.source.url}`}</Muted>
            </View>
            <Tag
              tone={deadlineTone(deadline.status)}
              label={t(`compliance.deadlines.status.${deadline.status}`)}
            />
          </Row>
        ))}
        {deadlines.data.unavailable.map((each) => (
          <Row key={`${each.rule}-${each.country}-${each.state}`}>
            <View className="gap-0.5 flex-1 min-w-56">
              <Text variant="body-2-semibold">{placeLabel(each.country, each.state)}</Text>
              <Muted>{each.reason}</Muted>
            </View>
            <Tag tone="neutral" label={t('compliance.deadlines.unavailable')} />
          </Row>
        ))}
      </Section>
      <Section title={t('compliance.roadmap.title')} description={t('compliance.roadmap.help')}>
        {roadmap.map((each) => (
          <Row key={each.id}>
            <View className="gap-0.5 flex-1 min-w-56">
              <Text variant="body-2-semibold">{each.id.replaceAll('_', ' ')}</Text>
              <Muted>{each.reason}</Muted>
            </View>
            <Tag tone="neutral" label={t('compliance.capability.not_available')} />
          </Row>
        ))}
      </Section>
    </View>
  );
}

// ── History ──────────────────────────────────────────────────────────────────

export function HistorySection({ scope }: { scope: DashboardScope }) {
  const actions = useCompliance(scope, 'actions');
  if (actions.error) return <ErrorNotice error={actions.error} onRetry={actions.refetch} />;
  if (!actions.data)
    return <PageSkeleton variant="table" accessibilityLabel={t('compliance.section.history')} />;
  return (
    <Section title={t('compliance.history.title')}>
      {actions.data.data.length === 0 ? <Muted>{t('compliance.history.empty')}</Muted> : null}
      {actions.data.data.map((row) => (
        <Row key={row.id}>
          <View className="gap-0.5 flex-1 min-w-56">
            <Text variant="body-2-semibold" selectable>
              {`${row.action}${row.object_id ? ` · ${row.object_id}` : ''}`}
            </Text>
            <Muted>
              {t('compliance.history.by', {
                actor:
                  row.actor.type === 'service'
                    ? t('compliance.history.service')
                    : (row.actor.id ?? '—'),
                at: formatInstant(row.created),
              })}
            </Muted>
          </View>
        </Row>
      ))}
    </Section>
  );
}
