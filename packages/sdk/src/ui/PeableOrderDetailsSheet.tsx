import { useRef } from 'react';
import { PeableBrandStatus } from './PeableBrandStatus';
import { checkoutMessage } from './messages';
import { OrderStatusBar, OrderStatusTimeline } from '@oxy.so/bloom/order-status';
import { View } from 'react-native';
import { Dialog, useDialogFrame } from '@oxy.so/bloom/dialog';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { Text } from '@oxy.so/bloom/typography';
import { Button } from '@oxy.so/bloom/button';
import { Checkbox } from '@oxy.so/bloom/checkbox';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { formatCheckoutAmount } from './amount';
import {
  availableOrderReward,
  matchingRewardOffers,
  selectedRewardCategories,
  type PeableOrderDetails,
  type PeableOrderReward,
  type PeableRewardOffer,
  type OrderRewardScreen,
} from './orderRewards';

export interface PeableOrderDetailsSheetProps {
  open: boolean;
  order: PeableOrderDetails;
  reward?: PeableOrderReward;
  now: number;
  screen: OrderRewardScreen;
  selectedCategories: readonly string[];
  selectedOfferId?: string;
  claiming?: boolean;
  claimedOffer?: PeableRewardOffer;
  claimError?: string;
  locale?: string;
  onScreen(screen: OrderRewardScreen): void;
  onCategories(ids: string[]): void;
  onOffer(id: string): void;
  /** Host verifies eligibility, order binding and explicit consent again; never an automatic claim. */
  onClaim(offer: PeableRewardOffer): void;
  onClose(): void;
  onPayEarly?: () => void;
  onOrderOptions?: () => void;
}
function orderCopy(locale: string) {
  return {
    order: checkoutMessage(locale, 'order.order'),
    reward: checkoutMessage(locale, 'order.reward'),
    categories: checkoutMessage(locale, 'order.categories'),
    offers: checkoutMessage(locale, 'order.offers'),
    offer: checkoutMessage(locale, 'order.offer'),
    claimed: checkoutMessage(locale, 'order.claimed'),
    paid: checkoutMessage(locale, 'order.paid'),
    remaining: checkoutMessage(locale, 'order.remaining'),
    scheduled: checkoutMessage(locale, 'order.scheduled'),
    next: checkoutMessage(locale, 'order.next'),
    options: checkoutMessage(locale, 'order.options'),
    early: checkoutMessage(locale, 'order.early'),
    explore: checkoutMessage(locale, 'order.explore'),
    skip: checkoutMessage(locale, 'order.skip'),
    continue: checkoutMessage(locale, 'order.continue'),
    select: checkoutMessage(locale, 'order.select'),
    confirm: checkoutMessage(locale, 'order.confirm'),
    done: checkoutMessage(locale, 'order.done'),
    terms: checkoutMessage(locale, 'order.terms'),
    unavailable: checkoutMessage(locale, 'order.unavailable'),
    none: checkoutMessage(locale, 'order.none'),
    minimum: checkoutMessage(locale, 'order.minimum'),
    complete: checkoutMessage(locale, 'order.complete'),
    review: checkoutMessage(locale, 'order.review'),
  };
}

function Content(props: PeableOrderDetailsSheetProps) {
  const { order, reward, screen, locale = 'en' } = props;
  const text = orderCopy(locale);
  useDialogFrame({
    key: `order:${order.id}:${screen}:${props.selectedOfferId ?? ''}`,
    direction: 'forward',
  });
  const money = (value: number) => formatCheckoutAmount(value, order.currency, locale);
  const available = availableOrderReward(order.id, reward, props.now);
  const offers = reward ? matchingRewardOffers(reward, props.selectedCategories) : [];
  const selected =
    offers.find((item) => item.id === props.selectedOfferId) ??
    (screen === 'offers' && !props.selectedOfferId ? offers[0] : undefined);
  const next = order.payments.find((item) => item.status === 'scheduled');
  const selectedIds = reward ? selectedRewardCategories(reward, props.selectedCategories) : [];
  const offerBody = selected ? (
    <>
      {selected.artwork && <View style={{ alignItems: 'center' }}>{selected.artwork}</View>}
      <Text variant="title-2-semibold">{selected.title}</Text>
      <Text>{selected.description}</Text>
    </>
  ) : null;
  return (
    <View style={{ padding: 20, gap: 20 }}>
      {screen === 'order' ? (
        <>
          <View style={{ alignItems: 'center', gap: 4 }}>
            <Text>{order.merchant}</Text>
            <Text variant="display-3-bold">{money(order.totalMinorUnits)}</Text>
            <Text>{order.placedOn}</Text>
          </View>
          <GroupedSection>
            {order.items.map((item) => (
              <GroupedSectionItem
                key={item.id}
                title={item.name}
                description={item.detail}
                icon={item.artwork}
              />
            ))}
          </GroupedSection>
          {props.claimedOffer && reward?.orderId === order.id && (
            <GroupedSection>
              <GroupedSectionItem
                title={text.claimed}
                description={props.claimedOffer.title}
                onPress={() => props.onScreen('claimed')}
              />
            </GroupedSection>
          )}
          {available && (
            <GroupedSection>
              <GroupedSectionItem
                title={reward.title}
                description={reward.deadlineLabel}
                onPress={() => props.onScreen('reward')}
              />
            </GroupedSection>
          )}
          {next && (
            <GroupedSection>
              <GroupedSectionItem
                title={text.next}
                description={`${next.date}${next.method ? ` · ${next.method}` : ''}`}
                rightElement={
                  <Text variant="title-2-semibold">{money(next.amountMinorUnits)}</Text>
                }
              />
            </GroupedSection>
          )}
          {(props.onOrderOptions || props.onPayEarly) && (
            <View style={{ flexDirection: 'row', gap: 12 }}>
              {props.onOrderOptions && (
                <Button onPress={props.onOrderOptions}>{text.options}</Button>
              )}
              {props.onPayEarly && <Button onPress={props.onPayEarly}>{text.early}</Button>}
            </View>
          )}
          <OrderStatusBar
            variant="plain"
            status={`${text.paid} · ${money(order.paidMinorUnits)}`}
            eta={`${text.remaining} · ${money(order.remainingMinorUnits)}`}
            progress={{
              value: order.paidMinorUnits,
              max: order.totalMinorUnits,
              accessibilityLabel: text.paid,
              valueText: `${money(order.paidMinorUnits)} / ${money(order.totalMinorUnits)}`,
            }}
          />
          <OrderStatusTimeline
            accessibilityLabel={text.scheduled}
            stateLabels={{ done: text.paid, upcoming: text.scheduled }}
            steps={order.payments.map((payment) => ({
              id: payment.id,
              label: money(payment.amountMinorUnits),
              timestamp: payment.date,
              note: payment.method,
              state: payment.status === 'paid' ? 'done' : 'upcoming',
            }))}
          />
          <Button size="lg" onPress={props.onClose}>
            {text.done}
          </Button>
        </>
      ) : screen === 'claimed' ? (
        <>
          <Text accessibilityRole="status">{text.complete}</Text>
          {offerBody}
          <Button size="lg" onPress={() => props.onScreen('order')}>
            {text.done}
          </Button>
        </>
      ) : !available ? (
        <>
          <Text accessibilityRole="alert">{text.unavailable}</Text>
          <Button onPress={() => props.onScreen('order')}>{text.done}</Button>
        </>
      ) : screen === 'reward' ? (
        <>
          <Text variant="title-2-semibold">{reward.title}</Text>
          <Text>{reward.description}</Text>
          <Text>{reward.deadlineLabel}</Text>
          {reward.terms.map((term) => (
            <Text key={term}>{term}</Text>
          ))}
          <Button size="lg" onPress={() => props.onScreen('categories')}>
            {text.explore}
          </Button>
          <Button onPress={() => props.onScreen('order')}>{text.skip}</Button>
        </>
      ) : screen === 'categories' ? (
        <>
          <Text>{text.minimum.replace('{count}', String(reward.minimumCategories))}</Text>
          <GroupedSection>
            {reward.categories.map((category) => (
              <GroupedSectionItem
                key={category.id}
                title={category.label}
                rightElement={
                  <Checkbox
                    accessibilityLabel={category.label}
                    checked={selectedIds.includes(category.id)}
                    onCheckedChange={(checked) =>
                      props.onCategories(
                        checked
                          ? [...selectedIds, category.id]
                          : selectedIds.filter((id) => id !== category.id),
                      )
                    }
                  />
                }
              />
            ))}
          </GroupedSection>
          <Button
            size="lg"
            disabled={selectedIds.length < reward.minimumCategories}
            onPress={() => props.onScreen('offers')}
          >
            {text.continue}
          </Button>
        </>
      ) : screen === 'offers' ? (
        offers.length ? (
          <>
            <SegmentedControl<string>
              label={text.offers}
              type="radio"
              value={selected?.id ?? ''}
              onValueChange={props.onOffer}
            >
              {offers.map((offer) => (
                <SegmentedControlItem key={offer.id} value={offer.id}>
                  <SegmentedControlItemText>{offer.title}</SegmentedControlItemText>
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
            {offerBody}
            <Button
              size="lg"
              onPress={() => {
                if (selected) {
                  props.onOffer(selected.id);
                  props.onScreen('offer');
                }
              }}
            >
              {text.select}
            </Button>
          </>
        ) : (
          <>
            <Text>{text.none}</Text>
            <Button onPress={() => props.onScreen('categories')}>{text.categories}</Button>
          </>
        )
      ) : selected ? (
        <>
          {offerBody}
          <Text>{text.review}</Text>
          <Text variant="title-2-semibold">{text.terms}</Text>
          {selected.terms.map((term) => (
            <Text key={term}>{term}</Text>
          ))}
          {props.claimError && <Text accessibilityRole="alert">{props.claimError}</Text>}
          <Button
            size="lg"
            disabled={props.claiming}
            onPress={() => {
              if (available && !props.claiming && selected.id === props.selectedOfferId)
                props.onClaim(selected);
            }}
          >
            {text.confirm}
          </Button>
        </>
      ) : (
        <>
          <Text>{text.unavailable}</Text>
          <Button onPress={() => props.onScreen('offers')}>{text.offers}</Button>
        </>
      )}
    </View>
  );
}
/** Controlled post-payment UI: no payment, reward activation, storage or provider requests. */
export function PeableOrderDetailsSheet(props: PeableOrderDetailsSheetProps) {
  const text = orderCopy(props.locale ?? 'en');
  const latest = useRef(props);
  latest.current = props;
  const close = () => {
    if (!latest.current.claiming) latest.current.onClose();
  };
  const back: Record<OrderRewardScreen, OrderRewardScreen> = {
    order: 'order',
    reward: 'order',
    categories: 'reward',
    offers: 'categories',
    offer: 'offers',
    claimed: 'order',
  };
  return (
    <Dialog
      open={props.open}
      placement="bottom"
      detached
      panelStyle={{ maxWidth: 540 }}
      contentPadding={0}
      onClose={close}
      footer={<PeableBrandStatus state={props.claiming ? 'loading' : 'idle'} />}
      footerBehavior="viewport"
      dismissOnBackdrop={!props.claiming}
      header={{
        title: text[props.screen],
        largeTitle: true,
        titleReveal: 'afterTitle',
        largeTitleAlign: props.screen === 'order' ? 'center' : 'left',
        largeTitleVariant: props.screen === 'order' ? 'title-2-semibold' : undefined,
        showClose: !props.claiming,
        onBack:
          props.screen !== 'order' && !props.claiming
            ? () => {
                if (!latest.current.claiming) latest.current.onScreen(back[latest.current.screen]);
              }
            : undefined,
      }}
    >
      <Content {...props} onClose={close} />
    </Dialog>
  );
}
