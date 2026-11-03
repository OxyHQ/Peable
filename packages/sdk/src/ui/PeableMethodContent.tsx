import { RiCheckLine } from '@oxy.so/bloom/icons/RiCheckLine';
import { validInstallmentQuote, type InstallmentQuote } from './installmentPlan';
import { walletObservationState, walletCanAuthorize, type WalletObservation } from './walletView';
import { useMemo, useState, type ReactNode } from 'react';
import { Image, View } from 'react-native';
import createQrCode from 'qrcode-generator';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';

/** Display data and capabilities supplied by the checkout host, never a wallet key or provider credential. */
export type PeableMethodDetails =
  | {
      kind: 'installments';
      quote?: InstallmentQuote;
      plans?: readonly { id: string; title: string; detail: string }[];
      selectedPlanId?: string;
      onPlan?(id: string): void;
      state?:
        | 'available'
        | 'checking'
        | 'pending'
        | 'ineligible'
        | 'rejected'
        | 'unavailable'
        | 'error';
      onRetry?(): void;
      interestLabel?: string;
      aprLabel?: string;
      repayment?: { label: string; detail?: string; onPress?(): void };
      autopayDescription?: string;
      terms?: string;
      termsVisible?: boolean;
      onTerms?(): void;
      onTermsBack?(): void;
      orderLabel?: string;
      dueTodayLabel: string;
      totalLabel: string;
      feesLabel: string;
      schedule: readonly { id: string; label: string; amountLabel: string }[];
      disclosure: string;
      onSelect(): void;
    }
  | {
      kind: 'provider';
      title: string;
      description: string;
      actionLabel: string;
      onContinue(): void;
    }
  | {
      kind: 'faircoin';
      amountLabel: string;
      quoteDescription: string;
      view: 'choices' | 'wallet' | 'external' | 'topup';
      wallet?: WalletObservation & {
        remainingLabel?: string;
        amountNeededLabel?: string;
        canPay: boolean;
        onOpen(): void;
        onSelect?(): void;
        onRetry?(): void;
        onConnect?(): void;
        topUp?: {
          payload: string;
          addressLabel: string;
          onCopy?(value: string): Promise<void>;
          onOpen(): void;
          notice?: ReactNode;
        };
      };
      external?: {
        state?: 'awaiting' | 'detected' | 'confirming' | 'settled' | 'failure' | 'expired';
        payload: string;
        addressLabel: string;
        onCopy?(value: string): Promise<void>;
        onOpen(): void;
        onSelect(): void;
      };
    };

export function PeableMethodContent({
  details,
  label,
}: {
  details: PeableMethodDetails;
  label(key: string): string;
}) {
  const [copyResult, setCopyResult] = useState<{ value: string; state: 'copied' | 'error' } | null>(
    null,
  );
  const receive =
    details.kind === 'faircoin'
      ? details.view === 'topup'
        ? details.wallet?.topUp
        : details.view === 'external'
          ? details.external
          : undefined
      : undefined;
  const qr = useMemo(() => {
    if (!receive?.payload) return undefined;
    const code = createQrCode(0, 'M');
    code.addData(receive.payload);
    code.make();
    return code.createDataURL(6, 8);
  }, [receive?.payload]);
  if (details.kind === 'installments' && details.quote && !validInstallmentQuote(details.quote))
    return <Text>{label('installments.unavailable')}</Text>;
  if (details.kind === 'installments' && details.state && details.state !== 'available')
    return (
      <>
        <Text variant="title-2-bold">{label(`installments.${details.state}`)}</Text>
        <Text>{details.disclosure}</Text>
        {details.onRetry && (
          <Button size="lg" onPress={details.onRetry}>
            {label('faircoin.retry')}
          </Button>
        )}
      </>
    );
  if (details.kind === 'installments' && details.termsVisible && details.terms)
    return (
      <>
        <Text>{details.terms}</Text>
        <Button size="lg" onPress={details.onTermsBack}>
          {label('continue')}
        </Button>
      </>
    );
  if (details.kind === 'installments')
    return (
      <>
        {details.plans && (
          <GroupedSection>
            {details.plans.map((plan) => (
              <GroupedSectionItem
                key={plan.id}
                title={plan.title}
                description={plan.detail}
                onPress={() => details.onPlan?.(plan.id)}
                accessibilityState={{ selected: plan.id === details.selectedPlanId }}
                rightElement={
                  plan.id === details.selectedPlanId ? <RiCheckLine size="md" /> : undefined
                }
                showChevron={false}
              />
            ))}
          </GroupedSection>
        )}
        <GroupedSection>
          {details.orderLabel && (
            <GroupedSectionItem
              title={label('orderTotal')}
              value={details.orderLabel}
              showChevron={false}
            />
          )}
          <GroupedSectionItem
            title={label('dueToday')}
            value={details.dueTodayLabel}
            showChevron={false}
          />
          <GroupedSectionItem
            title={label('installments.totalRepayable')}
            value={details.totalLabel}
            showChevron={false}
          />
          <GroupedSectionItem
            title={label('installments.fees')}
            value={details.feesLabel}
            showChevron={false}
          />
        </GroupedSection>
        <GroupedSection>
          {details.schedule.map((payment) => (
            <GroupedSectionItem
              key={payment.id}
              title={payment.label}
              value={payment.amountLabel}
              showChevron={false}
            />
          ))}
        </GroupedSection>
        {(details.interestLabel || details.aprLabel || details.repayment) && (
          <GroupedSection>
            {details.interestLabel && (
              <GroupedSectionItem
                title={label('installments.interest')}
                value={details.interestLabel}
                showChevron={false}
              />
            )}
            {details.aprLabel && (
              <GroupedSectionItem
                title={label('installments.apr')}
                value={details.aprLabel}
                showChevron={false}
              />
            )}
            {details.repayment && (
              <GroupedSectionItem
                title={label('installments.repayment')}
                value={details.repayment.label}
                description={details.repayment.detail}
                onPress={details.repayment.onPress}
                showChevron={!!details.repayment.onPress}
              />
            )}
          </GroupedSection>
        )}
        {details.autopayDescription && <Text>{details.autopayDescription}</Text>}
        <Text>{details.disclosure}</Text>
        {details.terms && details.onTerms && (
          <GroupedSection>
            <GroupedSectionItem title={label('terms')} onPress={details.onTerms} />
          </GroupedSection>
        )}
        <Button size="lg" onPress={details.onSelect}>
          {label('continue')}
        </Button>
      </>
    );
  if (details.kind === 'provider')
    return (
      <>
        <GroupedSection>
          <GroupedSectionItem
            title={details.title}
            description={details.description}
            descriptionLines={0}
            showChevron={false}
          />
        </GroupedSection>
        <Button size="lg" onPress={details.onContinue}>
          {details.actionLabel}
        </Button>
      </>
    );
  if (
    details.view === 'wallet' &&
    details.wallet &&
    walletObservationState(details.wallet) !== 'ready'
  )
    return (
      <>
        <Text>{label(`faircoin.balance.${walletObservationState(details.wallet)}`)}</Text>
        <Text>{label('faircoin.connectGuidance')}</Text>
        {details.wallet.onRetry && (
          <Button size="lg" onPress={details.wallet.onRetry}>
            {label('faircoin.retry')}
          </Button>
        )}
        {details.wallet.onConnect && (
          <Button size="lg" onPress={details.wallet.onConnect}>
            {label('faircoin.connect')}
          </Button>
        )}
      </>
    );
  if (details.view === 'wallet' && details.wallet)
    return (
      <>
        <View style={{ alignItems: 'center', gap: 8 }}>
          <Text>{label('faircoin.availableBalance')}</Text>
          <Text variant="display-3-bold">{details.wallet.balanceLabel}</Text>
          <Text style={{ textAlign: 'center' }}>{details.quoteDescription}</Text>
        </View>
        <GroupedSection>
          <GroupedSectionItem
            title={label('faircoin.amount')}
            value={details.amountLabel}
            showChevron={false}
          />
          <GroupedSectionItem
            title={label('faircoin.remaining')}
            value={details.wallet.remainingLabel}
            showChevron={false}
          />
          {details.wallet.amountNeededLabel && (
            <GroupedSectionItem
              title={label('faircoin.amountNeeded')}
              value={details.wallet.amountNeededLabel}
              showChevron={false}
            />
          )}
          {details.wallet.topUp && (
            <GroupedSectionItem
              title={label('faircoin.addFunds')}
              onPress={details.wallet.topUp.onOpen}
            />
          )}
        </GroupedSection>
        {details.wallet.onSelect ? (
          <Button
            size="lg"
            disabled={!walletCanAuthorize(details.wallet)}
            onPress={details.wallet.onSelect}
          >
            {label('continue')}
          </Button>
        ) : (
          <Text>{label('faircoin.authorizationNeeded')}</Text>
        )}
      </>
    );
  return (
    <>
      {details.view !== 'topup' && (
        <View style={{ alignItems: 'center', gap: 4 }}>
          <Text>{label('faircoin.amount')}</Text>
          <Text variant="display-3-bold">{details.amountLabel}</Text>
          {!!details.quoteDescription && <Text>{details.quoteDescription}</Text>}
        </View>
      )}
      {details.view === 'topup' && <Text>{label('faircoin.receiveHint')}</Text>}
      {details.view === 'choices' ? (
        <GroupedSection>
          {details.wallet && (
            <GroupedSectionItem
              title={label('faircoin.wallet')}
              value={
                walletObservationState(details.wallet) === 'ready'
                  ? details.wallet.balanceLabel
                  : label(`faircoin.balance.${walletObservationState(details.wallet)}`)
              }
              onPress={details.wallet.onOpen}
            />
          )}
          {details.external && (
            <GroupedSectionItem
              title={label('faircoin.external')}
              description={label('faircoin.externalHint')}
              onPress={details.external.onOpen}
            />
          )}
        </GroupedSection>
      ) : receive ? (
        <>
          {details.view === 'external' && (
            <Text variant="body-2-regular" style={{ textAlign: 'center' }}>
              {label('faircoin.externalHint')}
            </Text>
          )}
          <View style={{ alignItems: 'center', gap: 12 }}>
            {qr && (
              <Image
                testID={
                  details.view === 'topup'
                    ? 'peable-wallet-receive-qr'
                    : 'peable-external-payment-qr'
                }
                source={{ uri: qr }}
                style={{ width: 184, height: 184 }}
                accessibilityLabel={label(
                  details.view === 'topup' ? 'faircoin.receiveTitle' : 'faircoin.qr',
                )}
              />
            )}
            <Text selectable style={{ textAlign: 'center', alignSelf: 'stretch', flexShrink: 1 }}>
              {receive.addressLabel}
            </Text>
            {receive.onCopy && (
              <Button
                onPress={async () => {
                  try {
                    await receive.onCopy?.(receive.addressLabel);
                    setCopyResult({ value: receive.addressLabel, state: 'copied' });
                  } catch {
                    setCopyResult({ value: receive.addressLabel, state: 'error' });
                  }
                }}
              >
                {label(
                  copyResult?.value === receive.addressLabel
                    ? `faircoin.${copyResult.state}`
                    : 'faircoin.copy',
                )}
              </Button>
            )}
          </View>
          {details.view === 'topup' && details.wallet ? (
            <>
              {details.wallet.topUp?.notice}
              <Button size="lg" onPress={details.wallet.onOpen}>
                {label('faircoin.backToBalance')}
              </Button>
            </>
          ) : details.external?.state ? (
            <Text
              variant="body-2-medium"
              accessibilityLiveRegion="polite"
              style={{ textAlign: 'center', alignSelf: 'stretch' }}
            >
              {label(`faircoin.transfer.${details.external.state}`)}
            </Text>
          ) : details.external ? (
            <Button size="lg" onPress={details.external.onSelect}>
              {label('continue')}
            </Button>
          ) : null}
        </>
      ) : null}
    </>
  );
}
