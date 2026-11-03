import { useMemo, type ReactNode } from 'react';
import { Image, View } from 'react-native';
import createQrCode from 'qrcode-generator';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';

/** Display data and capabilities supplied by the checkout host, never a wallet key or provider credential. */
export type PeableMethodDetails =
  | {
      kind: 'installments';
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
      wallet?: {
        balanceLabel: string;
        remainingLabel: string;
        canPay: boolean;
        onOpen(): void;
        onSelect(): void;
        topUp?: { payload: string; addressLabel: string; onOpen(): void; notice?: ReactNode };
      };
      external?: { payload: string; addressLabel: string; onOpen(): void; onSelect(): void };
    };

export function PeableMethodContent({
  details,
  label,
}: {
  details: PeableMethodDetails;
  label(key: string): string;
}) {
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
  if (details.kind === 'installments')
    return (
      <>
        <GroupedSection>
          <GroupedSectionItem
            title={label('dueToday')}
            value={details.dueTodayLabel}
            showChevron={false}
          />
          <GroupedSectionItem
            title={label('orderTotal')}
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
        <Text>{details.disclosure}</Text>
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
          {details.wallet.topUp && (
            <GroupedSectionItem
              title={label('faircoin.addFunds')}
              onPress={details.wallet.topUp.onOpen}
            />
          )}
        </GroupedSection>
        <Button size="lg" disabled={!details.wallet.canPay} onPress={details.wallet.onSelect}>
          {label('continue')}
        </Button>
      </>
    );
  return (
    <>
      <GroupedSection>
        <GroupedSectionItem
          title={label(details.view === 'topup' ? 'faircoin.receiveTitle' : 'faircoin.amount')}
          value={details.view === 'topup' ? undefined : details.amountLabel}
          description={
            details.view === 'topup' ? label('faircoin.receiveHint') : details.quoteDescription
          }
          descriptionLines={0}
          showChevron={false}
        />
      </GroupedSection>
      {details.view === 'choices' ? (
        <GroupedSection>
          {details.wallet && (
            <GroupedSectionItem
              title={label('faircoin.wallet')}
              value={details.wallet.balanceLabel}
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
            <Text selectable style={{ textAlign: 'center' }}>
              {receive.addressLabel}
            </Text>
          </View>
          {details.view === 'topup' && details.wallet ? (
            <>
              {details.wallet.topUp?.notice}
              <Button size="lg" onPress={details.wallet.onOpen}>
                {label('faircoin.backToBalance')}
              </Button>
            </>
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
