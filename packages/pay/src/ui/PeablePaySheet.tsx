/**
 * The sheet an Oxy app opens to pay a person.
 *
 * It exists so that paying someone does not require the Peable app: `@peable.to/pay`
 * already holds the money logic, and this is the one screen that drives it. The
 * host app supplies two things it alone can — who is being paid, and a way to
 * reserve an address for them through the gateway — and nothing else.
 *
 * This file is DELIBERATELY thin. Which screen shows, what gets sent, how the
 * typed amount parses and what a failure means are all in `./machine`,
 * `./amount` and `./failure`, which are pure and tested; this one renders them
 * and runs two effects. No React Native renderer is configured anywhere in this
 * monorepo, so logic that stayed in here would ship with no test behind it.
 *
 * THE SEED IS NEVER HELD. `wallet.getSeed` is a callback, not a value, and the
 * bytes it returns live in one async function's local `const` and are zeroed in
 * its `finally`. A seed passed in as a PROP would instead sit in the parent's
 * element tree for as long as the sheet is mounted — visible to React DevTools'
 * props inspector, and serialised by any error reporter that snapshots the tree
 * when something unrelated throws. Neither is a breach on its own; both are the
 * kind of copy nobody remembers making. The cost of the callback is that the
 * caller must return bytes THIS SHEET OWNS (derive fresh per call), because they
 * come back zeroed — `sendPayment` deliberately does not wipe its argument, and
 * something has to.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, View } from 'react-native';
import { COIN_TICKER, formatFair, type NetworkType } from '@fairco.in/core';
import { Dialog, type DialogControlProps } from '@oxy.so/bloom/dialog';
import { Button } from '@oxy.so/bloom/button';
import { TextField, TextFieldInput } from '@oxy.so/bloom/text-field';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Divider } from '@oxy.so/bloom/divider';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text as BloomText } from '@oxy.so/bloom/typography';

import { quotePayment, sendPayment, type ChainAccess } from '../payment';
import {
  DEFAULT_PRESETS_SAT,
  amountEntryMessage,
  amountInputFor,
  sanitizeAmountInput,
} from './amount';
import { classifyPayFailure } from './failure';
import {
  handoffFor,
  initialPayState,
  paidFrom,
  payReducer,
  prepareFromQuote,
  sendRequestFor,
  type PaidPayment,
  type PayState,
} from './machine';
import { PayQrCode } from './PayQrCode';

export interface PayRecipient {
  readonly username: string;
  readonly displayName?: string;
  /** Oxy file id, resolved by the host app's Bloom `ImageResolver`. */
  readonly avatarFileId?: string;
}

/**
 * Where the payment was started from. Display and telemetry ONLY — it reaches
 * the chain solely as the `label` on the handoff URI, and never influences the
 * amount, the address or the fee.
 */
export interface PaySource {
  readonly app: string;
  readonly ref?: string;
}

export interface PaySheetWallet {
  readonly network: NetworkType;
  /**
   * Derives the wallet seed, on demand, for ONE chain operation.
   *
   * Its ABSENCE is what puts the sheet into the hand-off screen — not
   * `Platform.OS`. A browser has no device keystore, so a web host has no seed
   * to give; but the question this sheet needs answered is "can this surface
   * sign", and asking that directly means a host that gains a signer later needs
   * no change here. Say what is absent, not which platform you are on.
   *
   * The returned bytes are ZEROED when the operation finishes, so return a fresh
   * buffer each call rather than a cached one.
   */
  readonly getSeed?: () => Uint8Array | Promise<Uint8Array>;
  readonly minConfirmations?: number;
}

export interface PeablePaySheetProps {
  /** `useDialogControl()` from `@oxy.so/bloom/dialog`. */
  readonly control?: DialogControlProps;
  /** Controlled alternative to `control`; when set it wins, per Bloom's Dialog. */
  readonly open?: boolean;
  readonly onClose?: () => void;
  readonly recipient: PayRecipient;
  /**
   * Reserves a fresh receive address for the recipient, through the gateway.
   *
   * The sheet never talks to the gateway itself — the host app owns that client
   * and its auth. A rejection with the gateway's 409 `keyless_recipient` (in any
   * of the shapes a client surfaces it as) becomes "they can't receive yet"
   * rather than an error message.
   */
  readonly resolveAddress: () => Promise<{ address: string }>;
  readonly wallet: PaySheetWallet;
  readonly source?: PaySource;
  /** One-tap amounts, in base units. Defaults to 1 / 5 / 10 FAIR. */
  readonly presetsSat?: readonly bigint[];
  /** Injectable Explorer seam, forwarded to `quotePayment` / `sendPayment`. */
  readonly chain?: ChainAccess;
  readonly onPaid?: (result: PaidPayment) => void;
}

const QR_SIZE = 200;

export function PeablePaySheet({
  control,
  open,
  onClose,
  recipient,
  resolveAddress,
  wallet,
  source,
  presetsSat = DEFAULT_PRESETS_SAT,
  chain,
  onPaid,
}: PeablePaySheetProps) {
  const theme = useTheme();
  const [state, dispatch] = useReducer(payReducer, undefined, () => initialPayState());

  // Props read inside the two async effects, held in a ref so a re-render with a
  // new `resolveAddress` identity (the common case — host apps build it inline)
  // does not re-run an effect that is mid-payment.
  const latest = useRef({ resolveAddress, wallet, chain, source, onPaid });
  latest.current = { resolveAddress, wallet, chain, source, onPaid };

  // One attempt starts one request, whatever React does with the effect.
  // StrictMode invokes every effect twice on mount, and so does a dev remount;
  // an unguarded send effect would broadcast the same signed transaction twice.
  // A ref, not state: it must survive the second invocation, which state reset
  // between renders would not.
  const started = useRef<string | null>(null);

  const step = state.step;
  const attempt = state.attempt;

  useEffect(() => {
    if (step !== 'preparing' && step !== 'sending') return;
    const key = `${step}:${attempt}`;
    if (started.current === key) return;
    started.current = key;

    if (step === 'preparing') {
      void prepare(state, latest.current, dispatch);
    } else {
      void send(state, latest.current, dispatch);
    }
    // `state` is intentionally not a dependency: the effect keys off the step and
    // the attempt, and re-running it for any other change to the state object is
    // a second payment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, attempt]);

  const handleClose = useCallback(() => {
    // A sheet reopened after a receipt must not show the previous receipt. The
    // reset runs on close rather than on open so nothing is briefly rendered
    // stale behind the opening animation.
    dispatch({ type: 'restart' });
    onClose?.();
  }, [onClose]);

  const styles = useMemo(() => makeStyles(theme.colors), [theme.colors]);

  return (
    <Dialog
      control={control}
      open={open}
      onClose={handleClose}
      placement={{ base: 'bottom', md: 'center' }}
      label={`Pay @${recipient.username}`}
    >
      <View style={styles.root}>
        <RecipientRow recipient={recipient} source={source} styles={styles} colors={theme.colors} />
        <Divider />
        <Body
          state={state}
          styles={styles}
          colors={theme.colors}
          presetsSat={presetsSat}
          canSign={wallet.getSeed !== undefined}
          dispatch={dispatch}
        />
      </View>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Effects — the only two places this file talks to the chain
// ---------------------------------------------------------------------------

type Dispatch = (event: Parameters<typeof payReducer>[1]) => void;

interface EffectDeps {
  resolveAddress: PeablePaySheetProps['resolveAddress'];
  wallet: PaySheetWallet;
  chain: ChainAccess | undefined;
  source: PaySource | undefined;
  onPaid: PeablePaySheetProps['onPaid'];
}

/**
 * Hold a seed for exactly one operation.
 *
 * The `finally` is the point: it zeroes on the throw path too, so a quote that
 * fails because the Explorer is down does not leave the wallet's seed in the
 * heap until the next garbage collection decides otherwise.
 */
async function withSeed<T>(
  getSeed: NonNullable<PaySheetWallet['getSeed']>,
  use: (seed: Uint8Array) => Promise<T>,
): Promise<T> {
  const seed = await getSeed();
  try {
    return await use(seed);
  } finally {
    seed.fill(0);
  }
}

async function prepare(
  state: Extract<PayState, { step: 'preparing' }>,
  deps: EffectDeps,
  dispatch: Dispatch,
): Promise<void> {
  const { attempt, amountSat } = state;

  let address: string;
  try {
    address = (await deps.resolveAddress()).address;
  } catch (error) {
    dispatch({ type: 'failed', attempt, failure: classifyPayFailure('resolve', error) });
    return;
  }

  const getSeed = deps.wallet.getSeed;
  if (getSeed === undefined) {
    // No signer here. The reservation still happened, so the address is real and
    // the phone that scans it pays the person this sheet was opened for.
    dispatch({ type: 'handoff', attempt, offer: handoffFor(address, amountSat, deps.source?.app) });
    return;
  }

  try {
    const quote = await withSeed(getSeed, (seed) =>
      quotePayment(
        {
          seed,
          network: deps.wallet.network,
          minConfirmations: deps.wallet.minConfirmations,
          amountSat,
        },
        deps.chain,
      ),
    );
    const outcome = prepareFromQuote(quote, address, amountSat);
    if (outcome.kind === 'failed') {
      dispatch({ type: 'failed', attempt, failure: outcome.failure });
      return;
    }
    dispatch({ type: 'prepared', attempt, reviewed: outcome.reviewed });
  } catch (error) {
    dispatch({ type: 'failed', attempt, failure: classifyPayFailure('prepare', error) });
  }
}

async function send(
  state: Extract<PayState, { step: 'sending' }>,
  deps: EffectDeps,
  dispatch: Dispatch,
): Promise<void> {
  const { attempt, reviewed } = state;
  const getSeed = deps.wallet.getSeed;
  if (getSeed === undefined) {
    // Unreachable through the UI — a sheet with no signer never reaches `review`,
    // so it can never reach `sending`. Refusing rather than asserting keeps the
    // day that stops being true from being a crash inside a payment.
    dispatch({
      type: 'failed',
      attempt,
      failure: classifyPayFailure('send', new Error('Refusing to send: no signer on this device')),
    });
    return;
  }

  try {
    const result = await withSeed(getSeed, (seed) =>
      sendPayment(
        sendRequestFor(reviewed, seed, deps.wallet.network, deps.wallet.minConfirmations),
        deps.chain,
      ),
    );
    const paid = paidFrom(reviewed, result);
    dispatch({ type: 'paid', attempt, paid });
    deps.onPaid?.(paid);
  } catch (error) {
    dispatch({ type: 'failed', attempt, failure: classifyPayFailure('send', error) });
  }
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

type Styles = ReturnType<typeof makeStyles>;
type Colors = ReturnType<typeof useTheme>['colors'];

function RecipientRow({
  recipient,
  source,
  styles,
  colors,
}: {
  recipient: PayRecipient;
  source: PaySource | undefined;
  styles: Styles;
  colors: Colors;
}) {
  return (
    <View style={styles.recipientRow}>
      <Avatar source={recipient.avatarFileId ?? null} name={recipient.displayName ?? recipient.username} size={44} />
      <View style={styles.recipientText}>
        <BloomText style={[styles.title, { color: colors.text }]} numberOfLines={1}>
          {recipient.displayName ?? `@${recipient.username}`}
        </BloomText>
        <BloomText style={[styles.caption, { color: colors.textSecondary }]} numberOfLines={1}>
          {source ? `@${recipient.username} · from ${source.app}` : `@${recipient.username}`}
        </BloomText>
      </View>
    </View>
  );
}

function Body({
  state,
  styles,
  colors,
  presetsSat,
  canSign,
  dispatch,
}: {
  state: PayState;
  styles: Styles;
  colors: Colors;
  presetsSat: readonly bigint[];
  canSign: boolean;
  dispatch: Dispatch;
}) {
  switch (state.step) {
    case 'amount': {
      const message = amountEntryMessage(state.entry);
      return (
        <View style={styles.section}>
          <View style={styles.presets}>
            {presetsSat.map((preset) => (
              <Pressable
                key={preset.toString()}
                onPress={() => dispatch({ type: 'preset-picked', amountSat: preset })}
                style={[
                  styles.preset,
                  {
                    backgroundColor:
                      state.input === amountInputFor(preset) ? colors.primarySubtle : colors.backgroundSecondary,
                    borderColor: colors.border,
                  },
                ]}
                accessibilityRole="button"
                accessibilityLabel={`${formatFair(preset)} ${COIN_TICKER}`}
              >
                <BloomText style={[styles.presetLabel, { color: colors.text }]}>
                  {formatFair(preset)}
                </BloomText>
              </Pressable>
            ))}
          </View>

          <TextField isInvalid={message !== null}>
            <TextFieldInput
              label={`Amount in ${COIN_TICKER}`}
              floatingLabel
              value={state.input}
              // Sanitised on the way in: a paste or a hardware keyboard can put
              // anything into a field a numeric keyboard only ASKED to be numeric.
              onChangeText={(text) =>
                dispatch({ type: 'amount-typed', text: sanitizeAmountInput(text) })
              }
              keyboardType="decimal-pad"
              inputMode="decimal"
              isInvalid={message !== null}
              onSubmitEditing={() => dispatch({ type: 'continue' })}
            />
          </TextField>
          {message !== null ? (
            <BloomText style={[styles.caption, { color: colors.error }]}>{message}</BloomText>
          ) : null}

          <Button
            variant="primary"
            disabled={state.entry.kind !== 'ok'}
            onPress={() => dispatch({ type: 'continue' })}
          >
            {canSign ? 'Review payment' : 'Get a code to pay'}
          </Button>
        </View>
      );
    }

    case 'preparing':
      return (
        <Waiting
          styles={styles}
          colors={colors}
          label={canSign ? 'Working out the fee…' : 'Getting an address…'}
        />
      );

    case 'review':
      return (
        <View style={styles.section}>
          <SummaryRow styles={styles} colors={colors} label="Amount" value={fair(state.reviewed.amountSat)} />
          {/* The fee the payer agrees to. `sendPayment` is called with the rate
              this row was priced at, so the number here is the number charged. */}
          <SummaryRow styles={styles} colors={colors} label="Network fee" value={fair(state.reviewed.feeSat)} />
          <Divider />
          <SummaryRow styles={styles} colors={colors} label="Total" value={fair(state.reviewed.totalSat)} strong />
          <BloomText style={[styles.mono, { color: colors.textTertiary }]} numberOfLines={1}>
            {state.reviewed.to}
          </BloomText>
          <Button variant="primary" onPress={() => dispatch({ type: 'confirm' })}>
            {`Send ${fair(state.reviewed.amountSat)}`}
          </Button>
          <Button variant="text" onPress={() => dispatch({ type: 'edit' })}>
            Change amount
          </Button>
        </View>
      );

    case 'handoff':
      return (
        <View style={styles.section}>
          <BloomText style={[styles.title, { color: colors.text }]}>Continue on your phone</BloomText>
          <BloomText style={[styles.caption, { color: colors.textSecondary }]}>
            {`This browser has no wallet key, so it can't sign a payment. Scan this with the ${COIN_TICKER} wallet on your phone — the amount is already filled in.`}
          </BloomText>
          <View style={styles.qrWrap}>
            <PayQrCode value={state.offer.uri} size={QR_SIZE} />
          </View>
          <SummaryRow styles={styles} colors={colors} label="Amount" value={fair(state.offer.amountSat)} strong />
          {/* The URI in plain text under the code: a QR is useless to someone
              pasting the link into a message or reading it over a call. */}
          <BloomText style={[styles.mono, { color: colors.textTertiary }]} selectable>
            {state.offer.uri}
          </BloomText>
          <Button variant="text" onPress={() => dispatch({ type: 'edit' })}>
            Change amount
          </Button>
        </View>
      );

    case 'sending':
      return <Waiting styles={styles} colors={colors} label="Sending…" />;

    case 'paid':
      return (
        <View style={styles.section}>
          <BloomText style={[styles.title, { color: colors.success }]}>Paid</BloomText>
          <SummaryRow styles={styles} colors={colors} label="Amount" value={fair(state.paid.amountSat)} strong />
          <SummaryRow styles={styles} colors={colors} label="Network fee" value={fair(state.paid.feeSat)} />
          <BloomText style={[styles.mono, { color: colors.textTertiary }]} numberOfLines={1} selectable>
            {state.paid.txid}
          </BloomText>
          <Button variant="secondary" onPress={() => void Linking.openURL(state.paid.explorerUrl)}>
            View on the explorer
          </Button>
        </View>
      );

    case 'failed':
      return (
        <View style={styles.section}>
          <BloomText style={[styles.title, { color: colors.error }]}>{state.failure.title}</BloomText>
          {state.failure.detail !== null ? (
            <BloomText style={[styles.caption, { color: colors.textSecondary }]}>
              {state.failure.detail}
            </BloomText>
          ) : null}
          {/* `recovery` is the machine's answer, not a rendering choice: a failure
              after broadcast never offers a one-tap retry of the same signed
              payment, because a lost response is indistinguishable from a
              rejection and the inputs may already be spent. */}
          {state.recovery === 'edit' ? (
            <Button variant="primary" onPress={() => dispatch({ type: 'edit' })}>
              Try a different amount
            </Button>
          ) : (
            <Button variant="primary" onPress={() => dispatch({ type: 'restart' })}>
              Start over
            </Button>
          )}
        </View>
      );
  }
}

function Waiting({ styles, colors, label }: { styles: Styles; colors: Colors; label: string }) {
  return (
    <View style={styles.waiting}>
      <ActivityIndicator color={colors.primary} />
      <BloomText style={[styles.caption, { color: colors.textSecondary }]}>{label}</BloomText>
    </View>
  );
}

function SummaryRow({
  styles,
  colors,
  label,
  value,
  strong,
}: {
  styles: Styles;
  colors: Colors;
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <View style={styles.summaryRow}>
      <BloomText style={[styles.caption, { color: colors.textSecondary }]}>{label}</BloomText>
      <BloomText
        style={[strong ? styles.title : styles.caption, { color: colors.text }]}
        numberOfLines={1}
      >
        {value}
      </BloomText>
    </View>
  );
}

function fair(value: bigint): string {
  return `${formatFair(value)} ${COIN_TICKER}`;
}

function makeStyles(colors: Colors) {
  return StyleSheet.create({
    root: { gap: 16 },
    recipientRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    recipientText: { flex: 1, gap: 2 },
    section: { gap: 12 },
    presets: { flexDirection: 'row', gap: 8 },
    preset: {
      flex: 1,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 999,
      paddingVertical: 10,
      alignItems: 'center',
    },
    presetLabel: { fontSize: 15, fontWeight: '600' },
    title: { fontSize: 17, fontWeight: '700' },
    caption: { fontSize: 13 },
    mono: { fontSize: 12, fontFamily: 'monospace' },
    summaryRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
    waiting: { paddingVertical: 32, alignItems: 'center', gap: 12 },
    qrWrap: { alignItems: 'center', paddingVertical: 8, backgroundColor: colors.background },
  });
}
