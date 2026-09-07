/**
 * Lightweight i18n system for FAIRWallet.
 * Supports English and Spanish with device-locale detection.
 * No heavy library dependencies - simple key-value translations.
 */

import { getLocales, getCalendars } from "expo-localization";
import { UNITS_PER_COIN } from "@fairco.in/core";
import { getItemAsync, setItemAsync } from "../storage/kv-store";
import { isSupportedLanguage } from "./languages";

export {
  SUPPORTED_LANGUAGES,
  findLanguageOption,
  isSupportedLanguage,
} from "./languages";
export type { LanguageOption } from "./languages";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Codes for which a complete translation table exists in this module.
 * Used for `t()` lookups. Any other supported code stored via `setLanguage`
 * will transparently fall back to English through `t()`.
 */
type TranslatedLanguage = "en" | "es";

/**
 * The current UI language code. May be any entry from `SUPPORTED_LANGUAGES`
 * (see `./languages.ts`); codes that don't have a translation table fall back
 * to English string-by-string via `t()`.
 */
export type Language = string;

export type TranslationParams = Record<string, string | number>;

const STORAGE_KEY = "fairwallet_language";

// ---------------------------------------------------------------------------
// Translation strings
// ---------------------------------------------------------------------------

const translations: Record<TranslatedLanguage, Record<string, string>> = {
  en: {
    // ---------- Common ----------
    "common.ok": "OK",
    "common.cancel": "Cancel",
    "common.save": "Save",
    "common.delete": "Delete",
    "common.confirm": "Confirm",
    "common.error": "Error",
    "common.loading": "Loading...",
    "common.paste": "Paste",
    "common.copy": "Copy",
    "common.copied": "Copied",
    "common.done": "Done",
    "common.back": "Back",
    "common.close": "Close",
    "common.retry": "Retry",
    "common.edit": "Edit",
    "common.import": "Import",
    "common.create": "Create",
    "common.switch": "Switch",
    "common.no": "No",
    "common.clear": "Clear",

    // ---------- Not found ----------
    "notFound.title": "Page not found",
    "notFound.description": "We couldn't find the screen you were looking for. It may have been moved or removed.",
    "notFound.goHome": "Back to wallet",

    // ---------- Public profile (/@username) ----------
    "profile.notFound.title": "No one goes by @{username}",
    "profile.notFound.description": "That handle isn't registered on Oxy. Check the spelling, or ask them for their link.",
    "profile.error.title": "Couldn't load this profile",
    "profile.error.description": "Something went wrong reaching Oxy. Check your connection and try again.",
    "readOnly.title": "You're signed in on the web",
    "readOnly.subtitle": "Spending needs the key on your phone, so this browser can't send. Everything below needs no key at all.",
    "readOnly.history.title": "Your Peable payments",
    "readOnly.history.empty": "No payments yet. Share your code above and they'll show up here.",
    "readOnly.history.sent": "Sent to {name}",
    "readOnly.history.received": "Received from {name}",
    "readOnly.history.unknownParty": "someone",
    "readOnly.history.unclaimed": "{amount} FAIR still on this address",
    "readOnly.history.error": "Couldn't load your payments. Check your connection and try again.",
    "readOnly.balanceNote": "This is what Peable minted for you, not your whole wallet balance — that lives on your phone.",
    "profile.self": "This is you. Share this code or your link so people can send you FAIR.",
    "profile.send": "Send FAIR to {name}",
    "profile.reserving": "Preparing address...",
    "profile.signIn.description": "Sign in with Oxy to send @{username} money.",
    "profile.walletNotReady": "Finish setting up your Peable wallet, then come back to pay.",
    "profile.mainnetBlocked": "Paying by handle isn't ready for mainnet yet, so @{username} can't be paid from this wallet. Switch to testnet in Settings to try it.",
    "profile.testnetOnly": "Paying by handle runs on testnet only for now.",
    "profile.web.title": "Peable lives on your phone",
    "profile.web.description": "Your keys are derived on your device and never leave it, so sending {name} money happens in the Peable app.",
    "profile.web.openApp": "Open in the Peable app",
    "profile.error.keyless": "@{username} hasn't set up an Oxy identity yet, so there's nowhere to send money. Invite them to Peable.",
    "profile.error.reserve": "Couldn't prepare a payment address. Try again in a moment.",

    // ---------- Wallet / Home ----------
    "wallet.title": "Wallet",
    "wallet.balance": "Total Balance",
    "wallet.send": "Send",
    "wallet.receive": "Receive",
    "wallet.settings": "Settings",
    "wallet.contacts": "Contacts",
    "wallet.buy": "Buy",
    "wallet.nodes": "Nodes",
    "wallet.places": "Places",
    "wallet.activity": "Activity",
    "wallet.overview": "Overview",
    "overview.priceChart.title": "FAIR Price",
    "overview.priceChart.unavailable": "Price data unavailable",
    "overview.priceChart.notEnoughData": "Not enough price history yet",
    "overview.priceChart.window": "Last 7 days",
    "overview.staking.title": "Staking & Rewards",
    "overview.staking.totalEarned": "Total earned",
    "overview.staking.last30Days": "Last 30 days",
    "overview.staking.rewardsReceived": "Rewards received",
    "overview.staking.empty.title": "No staking rewards yet",
    "overview.staking.empty.subtitle": "FairCoin rewards stakers and masternodes. Your rewards will appear here once they arrive.",
    "overview.network.title": "Network",
    "overview.network.blockHeight": "Block height",
    "overview.network.masternodes": "Masternodes",
    "overview.network.circulatingSupply": "Circulating supply",
    "overview.network.unavailable": "Network data unavailable",
    "wallet.date.today": "Today",
    "wallet.date.yesterday": "Yesterday",
    "wallet.activity.empty.title": "No activity yet",
    "wallet.activity.empty.subtitle": "Your transactions will appear here",
    "wallet.transactionCount.one": "{count} transaction",
    "wallet.transactionCount.other": "{count} transactions",
    "wallet.syncAccessibility": "Sync status: {label}",
    "wallet.defaultName": "Peable",
    "wallet.sync.offline": "Offline",
    "wallet.sync.syncing": "Syncing {progress}%",
    "wallet.sync.synced": "Synced",
    "wallet.peer.one": "peer",
    "wallet.peer.other": "peers",
    "wallet.block": "Block {height}",
    "wallet.badge.testnet": "TESTNET",

    // ---------- Send ----------
    "send.title": "Send FAIR",
    "send.to_address": "To Address",
    "send.amount": "Amount",
    "send.fee": "Fee",
    "send.total": "Total",
    "send.confirm": "Confirm Send",
    "send.success": "Transaction Sent",
    "send.sendTo": "Send to",
    "send.addressPlaceholder": "FairCoin address",
    "send.amountPlaceholder": "0",
    "send.available": "Available: {amount} FAIR",
    "send.usdApprox": "\u2248 ${amount} USD",
    "send.max": "MAX",
    "send.maxAccessibility": "Use maximum balance",
    "send.paste": "Paste",
    "send.scanQR": "Scan",
    "backup.banner.title": "Back up your wallet",
    "backup.banner.required": "Required",
    "backup.banner.subtitle":
      "Set up a recovery plan in case you lose your phone or get a new one.",
    "suggest.notifications.title": "Get paid alerts",
    "suggest.notifications.subtitle":
      "Turn on notifications to know the moment you receive FairCoin.",
    "send.contacts": "Contacts",
    "send.clearRecipient": "Clear recipient",
    "send.recipientMode.person": "Person",
    "send.recipientMode.address": "Address",
    "send.recipientMode.choosePlaceholder": "Choose who to pay",
    "send.recipientMode.reserving": "Getting their address…",
    "send.recipientMode.keyless": "@{username} hasn't set up Peable yet. Invite them to get paid instantly next time.",
    "send.recent": "Recent",
    "send.networkFee": "Network fee",
    "send.fee.low": "Low",
    "send.fee.medium": "Medium",
    "send.fee.high": "High",
    "send.feeUnit": "{units} m\u229c",
    "send.error.addressTooShort": "Address too short",
    "send.error.invalidAddress": "Invalid FairCoin address format",
    "send.error.invalidAmount": "Invalid amount",
    "send.error.insufficientBalance": "Insufficient balance",
    "send.error.failedSend": "Failed to send transaction",
    "send.error.clipboard": "Failed to read clipboard",
    "send.sendCta": "Send FAIR",
    "send.transactionSent": "Transaction sent: {txid}",
    "send.sent.title": "Transaction Sent",
    "send.sent.copy": "Copy Link",
    "send.sent.share": "Share Link",
    "send.confirm.title": "Confirm Transaction",
    "send.confirm.to": "To",
    "send.confirm.amount": "Amount",
    "send.confirm.fee": "Fee",
    "send.confirm.total": "Total",
    "send.confirm.cta": "Confirm Send",
    "send.saveContact.title": "Save Contact?",
    "send.saveContact.description": "Save {address} to contacts?",
    "send.saveContact.cta": "Save",
    "send.watchOnly.title": "Watch-Only Wallet",
    "send.watchOnly.subtitle":
      "Sending is disabled for watch-only wallets. Import the full wallet with a recovery phrase to enable sending.",

    // ---------- Approve pay ----------
    "pay.title": "Approve Payment",
    "pay.usdApprox": "≈ ${amount} USD",
    "pay.payTo": "Pay to",
    "pay.network": "Network",
    "pay.network.mainnet": "Mainnet",
    "pay.network.testnet": "Testnet",
    "pay.approve": "Approve & Pay",
    "pay.decline": "Decline",
    "pay.processing": "Signing & broadcasting...",
    "pay.status.broadcast.title": "Payment sent",
    "pay.status.broadcast.subtitle": "Waiting to be seen on-chain...",
    "pay.status.confirming.title": "Confirming",
    "pay.status.confirming.subtitle": "{count} confirmation(s) so far...",
    "pay.status.settled.title": "Payment settled",
    "pay.status.settled.subtitle": "The merchant has received your payment.",
    "pay.status.failed.title": "Payment failed",
    "pay.status.failed.subtitle": "This payment could not be completed.",
    "pay.status.expired.title": "Payment request expired",
    "pay.status.expired.subtitle": "This request is no longer valid.",
    "pay.status.rejected.title": "Payment rejected",
    "pay.status.rejected.subtitle": "The merchant rejected this payment.",
    "pay.sent.signedOut": "Payment sent - sign in to Oxy for live status.",
    "pay.signIn": "Sign in to Oxy",
    "pay.viewTransaction": "View transaction",
    "pay.invalid.title": "Invalid payment request",
    "pay.invalid.subtitle":
      "This payment link is malformed or incomplete and cannot be paid.",
    "pay.error.sendFailed": "Failed to send payment",
    "pay.error.networkMismatch":
      "This request is for {requested}, but your wallet is on {active}. Switch networks to pay.",
    "pay.error.watchOnly":
      "This is a watch-only wallet and cannot send payments.",
    "pay.error.notInitialized": "Your wallet is still loading. Try again in a moment.",
    "pay.notice.reportFailed":
      "Payment broadcast, but the gateway didn't confirm receipt. It will still settle on-chain.",
    "pay.notice.liveStatusUnavailable":
      "Payment sent. Live status is unavailable right now.",
    "pay.notice.openLinkFailed": "Couldn't open the explorer link.",

    // ---------- Buy ----------
    "buy.title": "Buy FAIR",
    "buy.subtitle": "Get FairCoin delivered to your wallet",
    "buy.amount.label": "How much FAIR?",
    "buy.usdApprox": "\u2248 ${amount} USD",
    "buy.method.label": "Pay with",
    "buy.payment.recommended": "Recommended",
    "buy.payment.comingSoon": "Coming soon",
    "buy.payment.usdcBase.label": "USDC on Base",
    "buy.payment.usdcBase.description": "Lowest fees, ~1 minute settlement",
    "buy.payment.ethBase.label": "ETH on Base",
    "buy.payment.ethBase.description": "Bridge auto-converts to USDC",
    "buy.payment.ethMainnet.label": "ETH on Ethereum",
    "buy.payment.ethMainnet.description": "Higher gas, slower bridge",
    "buy.payment.btc.label": "Bitcoin",
    "buy.payment.btc.description": "Slower confirmations (~10-30 min)",
    "buy.payment.card.label": "Card / Apple Pay / Google Pay",
    "buy.payment.card.description": "Powered by a regulated partner",
    "buy.quote.networkLabel.base": "Base",
    "buy.quote.estimatedDelivery": "60-180 seconds after payment confirms",
    "buy.cta.getInstructions": "Get payment instructions",
    "buy.error.belowMinimum": "Minimum order is {min} FAIR",
    "buy.error.aboveMaximum": "Maximum order is {max} FAIR",
    "buy.error.watchOnly":
      "Watch-only wallets cannot derive a delivery address. Import the wallet with its recovery phrase first.",
    "buy.error.cardNotConfigured":
      "Card payments are coming soon. Apply for early access at fairco.in/contact.",
    "buy.error.poolUnavailable":
      "Pool quote unavailable right now. Please try again in a moment.",
    "buy.error.network":
      "Network error contacting the bridge. Check your connection and retry.",
    "buy.error.generic": "Could not create your buy order: {message}",
    "buy.disclosure":
      "FAIR is a cryptocurrency. Purchases are non-refundable. Risk of loss applies.",
    "buy.deliveryTo": "Delivering to",
    "buy.feeBreakdown.title": "Includes",
    "buy.feeBreakdown.bridge": "Bridge fee {bps}%",
    "buy.feeBreakdown.slippage": "Slippage buffer {bps}%",
    "buy.instructions.title": "Send your payment",
    "buy.instructions.sendTo":
      "Send {symbol} on {network} to this address",
    "buy.instructions.exactAmount": "Send exactly",
    "buy.instructions.networkWarning":
      "Send {symbol} on the {network} network only. Funds sent on a different network will be lost.",
    "buy.instructions.expiresIn": "Expires in",
    "buy.instructions.copiedAddress": "Address copied",
    "buy.instructions.copiedAmount": "Amount copied",
    "buy.instructions.cancel": "Cancel order",
    "buy.instructions.viewTx": "View on Explorer",
    "buy.instructions.openCardWebview": "Open card payment page",
    "buy.status.awaiting.title": "Waiting for payment",
    "buy.status.awaiting.subtitle":
      "Send the amount above; we will detect it automatically.",
    "buy.status.detected.title": "Payment received",
    "buy.status.detected.subtitle": "Confirming on the network...",
    "buy.status.swapping.title": "Swapping on Uniswap",
    "buy.status.swapping.subtitle": "Converting your payment to FAIR",
    "buy.status.burning.title": "Bridging to FairCoin",
    "buy.status.burning.subtitle":
      "Burning WFAIR with your address attached",
    "buy.status.delivering.title": "Delivering FAIR",
    "buy.status.delivering.subtitle":
      "Broadcasting on the FairCoin network...",
    "buy.status.delivered.title": "FAIR delivered",
    "buy.status.delivered.subtitle":
      "Your FAIR has arrived. Tap below to view the transaction.",
    "buy.status.expired.title": "Quote expired",
    "buy.status.expired.subtitle":
      "Your payment window passed without a deposit. Start a new order to get a fresh quote.",
    "buy.status.failed.title": "Something went wrong",
    "buy.status.failed.subtitle":
      "We hit an unexpected issue processing your payment. Contact support if funds were sent.",

    // ---------- Receive ----------
    "receive.title": "Receive FAIR",
    "receive.payMeAt": "Pay me at",
    "receive.copy": "Copy Address",
    "receive.share": "Share",
    "receive.new_address": "New Address",
    "receive.subtitle": "Share this address to receive FairCoin",
    "receive.yourAddress": "Your address",
    "receive.addressCopied.title": "Copied",
    "receive.addressCopied.description": "Address copied to clipboard",
    "receive.hideList": "Hide list",
    "receive.allAddresses": "All ({count})",
    "receive.generating": "Generating receive address...",
    "receive.paymentRequestTitle": "FairCoin Payment Request",
    "receive.shareMessage": "Pay me with FairCoin:\n{uri}",

    // ---------- Settings ----------
    "settings.title": "Settings",
    "settings.contacts": "Contacts",
    "settings.security": "Security",
    "settings.network": "Network",
    "settings.backup": "Backup",
    "settings.advanced": "Advanced",
    "settings.about": "About",
    "settings.wipe": "Wipe Wallet",
    "settings.change_pin": "Change PIN",
    "settings.biometrics": "Biometric Unlock",
    "settings.show_phrase": "Show Recovery Phrase",
    "settings.auto_lock": "Auto-Lock",
    "settings.currency": "Display Currency",
    "settings.appearance": "Appearance",
    "settings.appearance.light": "Light",
    "settings.appearance.dark": "Dark",
    "settings.appearance.system": "System",
    "settings.language.title": "Language",
    "settings.walletsGroup": "Wallets",
    "settings.autoLockValue": "{minutes} min",
    "settings.exportKey": "Export Encrypted Key",
    "settings.mainnet": "Mainnet",
    "settings.testnet": "Testnet",
    "settings.networkStatus": "Network Status",
    "settings.connectedPeers": "Connected Peers",
    "settings.resync": "Resync Wallet",
    "settings.exportBackup": "Export Backup",
    "settings.importBackup": "Import Backup",
    "settings.coinControl": "Coin Control",
    "settings.masternode": "Masternode",
    "settings.aboutApp": "About Peable",
    "settings.version": "v{version}",
    "settings.dangerZone": "Danger Zone",
    "settings.pin.verify": "Verify PIN",
    "settings.pin.enterCurrent": "Enter Current PIN",
    "settings.pin.enterDescription": "Enter your 6-digit PIN",
    "settings.pin.wrong": "Wrong PIN. Try again.",
    "settings.pin.verificationFailed": "Verification failed. Try again.",
    "settings.recovery.title": "Recovery Phrase",
    "settings.recovery.description": "Keep these words safe and never share them.",
    "settings.recovery.error.retrieve": "Could not retrieve recovery phrase.",
    "settings.recovery.error.load": "Failed to load recovery phrase.",
    "settings.biometrics.unavailable.title": "Biometrics Unavailable",
    "settings.biometrics.unavailable.description":
      "Your device does not have biometric authentication set up. Please enable it in your device settings first.",
    "settings.biometrics.verifyPrompt": "Verify biometrics to enable",
    "settings.biometrics.updateError": "Failed to update biometrics setting.",
    "settings.backup.exportDialogTitle": "Save Peable backup",
    "settings.backup.saved.title": "Backup saved",
    "settings.backup.saved.description":
      "Saved to {path}. Sharing is not available on this platform.",
    "settings.backup.exportFailed": "Export failed",
    "settings.backup.importEmpty": "The selected file is empty.",
    "settings.backup.imported.title": "Backup Imported",
    "settings.backup.imported.description":
      "Contacts, labels, and settings have been restored.",
    "settings.backup.importFailed": "Import failed",
    "settings.wipe.title": "Wipe Wallet?",
    "settings.wipe.description":
      "This will permanently delete all wallets from this device. Make sure you have your recovery phrases backed up. This action cannot be undone.",
    "settings.wipe.cta": "Wipe All Wallets",
    "settings.switchNetwork.title": "Switch Network",
    "settings.switchNetwork.description":
      "Switch to {target}? This will require a resync.",
    "settings.switchNetwork.cta": "Switch",
    "settings.resync.title": "Resync Wallet",
    "settings.resync.description": "This will re-download all blockchain data.",
    "settings.resync.cta": "Resync",
    "settings.resync.failed": "Resync failed. Try again once you have peers.",

    // ---------- Contacts ----------
    "contacts.title": "Contacts",
    "contacts.add": "Add Contact",
    "contacts.edit": "Edit Contact",
    "contacts.empty": "No contacts yet",
    "contacts.search": "Search contacts...",
    "contacts.searchPill": "Search contacts",
    "contacts.newContact": "New contact",
    "contacts.saveAccessibility": "Save contact",
    "contacts.closeAccessibility": "Close",
    "contacts.backAccessibility": "Back",
    "contacts.addAccessibility": "Add contact",
    "contacts.clearSearchAccessibility": "Clear search",
    "contacts.pasteAccessibility": "Paste address from clipboard",
    "contacts.scanAccessibility": "Scan address from QR code",
    "contacts.field.name": "Name",
    "contacts.field.namePlaceholder": "Contact name",
    "contacts.field.address": "Address",
    "contacts.field.addressPlaceholder": "FairCoin address",
    "contacts.field.notes": "Notes",
    "contacts.field.notesPlaceholder": "Optional notes",
    "contacts.emptySearch": "No contacts match your search",
    "contacts.emptyAddOne": "Add one to get started",
    "contacts.clipboardError.title": "Clipboard Error",
    "contacts.clipboardError.description": "Failed to read from clipboard.",
    "contacts.copyAddress": "Copy Address",
    "contacts.delete.title": "Delete Contact",
    "contacts.delete.description": "Are you sure you want to delete \"{name}\"?",

    // ---------- Contact Picker ----------
    "contactPicker.title": "Pick Contact",
    "contactPicker.searchPlaceholder": "Search contacts...",
    "contactPicker.emptySearch": "No contacts match your search",
    "contactPicker.empty": "No contacts yet. Add one to get started.",

    // ---------- Social Recipient Picker ----------
    "socialRecipientPicker.title": "Pay a person",
    "socialRecipientPicker.searchPlaceholder": "Search by username or name",
    "socialRecipientPicker.prompt": "Search for someone to pay",
    "socialRecipientPicker.empty": "No one found",

    // ---------- Onboarding ----------
    "onboarding.logoAccessibility": "Peable logo",
    "onboarding.signInTitle": "Welcome to Peable",
    "onboarding.signInSubtitle": "Sign in with your Oxy account — your money is just there.",
    "onboarding.createIdentityTitle": "Set up your Oxy ID",
    "onboarding.createIdentitySubtitle": "Your wallet is secured by your Oxy identity. Create it to continue.",
    "onboarding.createIdentityCta": "Continue in Commons",
    "onboarding.commonsNotInstalled": "Commons by Oxy isn't installed on this device. Install it to set up your Oxy ID.",
    "onboarding.createIdentityError": "Couldn't reach Oxy. Check your connection and try again.",
    "onboarding.webFallbackTitle": "Open Peable on your phone",
    "onboarding.webFallbackSubtitle": "Spending needs the keys on your device. Sign in again, or open the app.",

    // PIN setup
    "onboarding.pin_setup": "Set a PIN",
    "onboarding.pin_confirm": "Confirm PIN",
    "onboarding.pin.create.title": "Create a passcode",
    "onboarding.pin.create.subtitle": "This passcode will protect your wallet",
    "onboarding.pin.confirm.title": "Confirm your passcode",
    "onboarding.pin.confirm.subtitle": "Re-enter your passcode to confirm",
    "onboarding.pin.mismatch": "Passcodes don't match. Let's try again.",
    "onboarding.pin.saveError": "Failed to save PIN",

    // ---------- Lock screen ----------
    "lock.title": "Enter PIN",
    "lock.biometric": "Use biometrics to unlock",
    "lock.enterPasscode": "Enter your passcode",
    "lock.unlockPrompt": "Unlock {app}",
    "lock.lockedFor": "Locked for {seconds}s",
    "lock.tooManyAttempts": "Too many attempts. Try again in {seconds}s.",
    "lock.wrongPasscode.one": "Wrong passcode. {count} attempt remaining.",
    "lock.wrongPasscode.other": "Wrong passcode. {count} attempts remaining.",
    "lock.verificationFailed": "Verification failed. Try again.",

    // ---------- Index / boot ----------
    "index.loading": "Loading wallet...",
    "index.error.load": "Failed to load wallet",
    "index.error.help": "Try restarting the app or wiping and restoring your wallet.",

    // ---------- Pockets ----------
    "pockets.title": "Pockets",
    "pockets.subtitle.one": "{count} pocket",
    "pockets.subtitle.other": "{count} pockets",
    "pockets.active": "Active",
    "pockets.mainName": "Main",
    "pockets.mainBadge": "Main",
    "pockets.mainSubtitle": "Your day-to-day pocket",
    "pockets.switcherTitle": "Switch pocket",
    "pockets.manage": "Manage pockets",
    "pockets.total.label": "Total across your pockets",
    "pockets.yourPockets": "Your pockets",
    "pockets.moveLink": "Move money →",
    "pockets.createCta": "New pocket",
    "pockets.create.subtitle": "Set aside money for a goal",
    "pockets.create.title": "New pocket",
    "pockets.create.lead":
      "A Pocket is a separate balance inside your wallet. It's still yours (self-custody), just organized.",
    "pockets.create.nameLabel": "POCKET NAME",
    "pockets.create.namePlaceholder": "e.g. Savings",
    "pockets.create.emojiLabel": "EMOJI",
    "pockets.create.colorLabel": "COLOR",
    "pockets.create.goalLabel": "GOAL (OPTIONAL)",
    "pockets.create.goalPlaceholder": "0.00",
    "pockets.create.cta": "Create pocket",
    "pockets.create.error.nameRequired": "Enter a name for the pocket",
    "pockets.create.error.invalidGoal": "Enter a valid goal amount",
    "pockets.create.error.failed": "Could not create the pocket",
    "pockets.edit.title": "Edit pocket",
    "pockets.edit.action": "Edit",
    "pockets.edit.cta": "Save changes",
    "pockets.edit.error.failed": "Could not save the pocket",
    "pockets.delete.title": "Delete pocket?",
    "pockets.delete.description": "Remove \"{name}\" from your pockets?",
    "pockets.delete.notEmpty": "Move funds out of this pocket before deleting it.",
    "pockets.delete.cannotMain": "The main pocket cannot be deleted.",
    "pockets.goal.progress": "{current} of {target} FAIR",
    "pockets.move.title": "Move between pockets",
    "pockets.move.fromLabel": "FROM",
    "pockets.move.toLabel": "TO",
    "pockets.move.to": "TO POCKET",
    "pockets.move.amountLabel": "AMOUNT",
    "pockets.move.cta": "Move",
    "pockets.move.ctaAmount": "Move {amount} FAIR",
    "pockets.move.max": "Max",
    "pockets.move.sameAccount": "Choose a different destination pocket.",
    "pockets.move.failed": "Could not move funds",
    "pockets.move.noDestinations.title": "No other pockets yet",
    "pockets.move.noDestinations.subtitle":
      "Create another pocket first, then come back here to move funds.",
    "pockets.detail.move": "Move",
    "pockets.detail.add": "Add funds",
    "pockets.detail.switch": "Switch",
    "pockets.detail.manageAction": "Manage",
    "pockets.detail.activityUnavailable.title": "Switch to see activity",
    "pockets.detail.activityUnavailable.subtitle":
      "Only the active pocket's activity is shown here.",
    "pockets.watchOnly.title": "Watch-Only Wallet",
    "pockets.watchOnly.subtitle":
      "Pockets are unavailable for watch-only wallets. Import the full wallet with a recovery phrase to use Pockets.",

    // ---------- Coin Control ----------
    "coinControl.title": "Coin Control",
    "coinControl.subtitle.one": "{count} UTXO available",
    "coinControl.subtitle.other": "{count} UTXOs available",
    "coinControl.selectAll": "Select All",
    "coinControl.clear": "Clear",
    "coinControl.unspentOutputs": "Unspent Outputs",
    "coinControl.empty.title": "No unspent outputs",
    "coinControl.empty.subtitle": "No UTXOs found in this wallet",
    "coinControl.selected.one": "Selected: {count} UTXO",
    "coinControl.selected.other": "Selected: {count} UTXOs",
    "coinControl.useCta.one": "Use {count} UTXO for Next Transaction",
    "coinControl.useCta.other": "Use {count} UTXOs for Next Transaction",
    "coinControl.selectCta": "Select UTXOs",
    "coinControl.applied.title": "Coin Control",
    "coinControl.applied.description.one":
      "{count} UTXO selected for next transaction.",
    "coinControl.applied.description.other":
      "{count} UTXOs selected for next transaction.",

    // ---------- Masternode ----------
    "masternode.title": "Masternode",
    "masternode.requirements.title": "Masternode Requirements",
    "masternode.requirements.description":
      "A FairCoin masternode requires exactly 5,000 FAIR as collateral in a single UTXO. The collateral must have at least 15 confirmations. Running a masternode earns you additional rewards for supporting the network.",
    "masternode.candidates": "Collateral Candidates",
    "masternode.empty.title": "No eligible UTXOs",
    "masternode.empty.subtitle":
      "Send exactly 5,000 FAIR to one of your addresses to create a masternode collateral",
    "masternode.broadcasting": "Broadcasting...",
    "masternode.startCta": "Start Masternode",
    "masternode.waiting": "Waiting for at least 15 confirmations on a collateral UTXO",
    "masternode.ipModal.title": "Masternode IP Address",
    "masternode.ipModal.description":
      "Enter the IP:port of your masternode server (e.g. 203.0.113.50:46372)",
    "masternode.ipModal.placeholder": "203.0.113.50:46372",
    "masternode.ipModal.error.empty": "Please enter an IP:port address.",
    "masternode.ipModal.error.invalid":
      "Please enter a valid IPv4:port (e.g. 203.0.113.50:46372).",
    "masternode.notReady.title": "Not Ready",
    "masternode.notReady.description":
      "No collateral UTXO with at least 15 confirmations found.",
    "masternode.confirm.title": "Confirm Masternode Start",
    "masternode.confirm.collateral": "Collateral:",
    "masternode.confirm.address": "Address:",
    "masternode.confirm.confirmations": "Confirmations:",
    "masternode.confirm.ip": "Masternode IP:",
    "masternode.confirm.note":
      "This will broadcast a masternode announcement to the network.",
    "masternode.broadcastSent.title": "Masternode Broadcast Sent",
    "masternode.broadcastSent.description":
      "Masternode broadcast for {ip}:{port} has been queued. It may take a few minutes for the network to recognize your masternode.",
    "masternode.notAvailable.title": "Not Yet Available",
    "masternode.notAvailable.description":
      "Starting a masternode requires broadcasting a signed announcement over the FairCoin P2P network, which this wallet does not yet support. You can prepare collateral now; masternode start will be enabled in a future update.",
    "masternode.notAvailableBadge": "Coming soon",

    // ---------- Export Key ----------
    "exportKey.verifyPin.title": "Verify PIN",
    "exportKey.verifyPin.subtitle": "Enter your PIN to access private key export",
    "exportKey.verifyPin.wrong": "Wrong PIN. Try again.",
    "exportKey.verifyPin.failed": "Verification failed.",
    "exportKey.select.title": "Select Address",
    "exportKey.select.subtitle":
      "Choose the address whose private key you want to export",
    "exportKey.select.empty.title": "No addresses found",
    "exportKey.select.empty.subtitle":
      "No addresses available for key export",
    "exportKey.passphrase.title": "Set Encryption Passphrase",
    "exportKey.passphrase.subtitle":
      "This passphrase will be needed to decrypt the exported key. Choose a strong passphrase and store it safely.",
    "exportKey.passphrase.label": "Passphrase",
    "exportKey.passphrase.placeholder": "Enter passphrase (min 8 characters)",
    "exportKey.passphrase.confirmLabel": "Confirm Passphrase",
    "exportKey.passphrase.confirmPlaceholder": "Confirm passphrase",
    "exportKey.passphrase.error.tooShort":
      "Passphrase must be at least 8 characters",
    "exportKey.passphrase.error.mismatch": "Passphrases do not match",
    "exportKey.passphrase.encrypting": "Encrypting...",
    "exportKey.passphrase.encryptCta": "Encrypt Private Key",
    "exportKey.error.noMnemonic": "Could not access wallet mnemonic.",
    "exportKey.error.noPrivateKey": "Could not find private key for this address.",
    "exportKey.error.encryptionFailed": "Encryption failed",
    "exportKey.result.title": "Encrypted Key",
    "exportKey.result.subtitle": "Your BIP38 encrypted private key",
    "exportKey.result.copyCta": "Copy Encrypted Key",
    "exportKey.result.copied.title": "Copied",
    "exportKey.result.copied.description": "Encrypted key copied to clipboard",
    "exportKey.warning.title": "Important",
    "exportKey.warning.description":
      "This encrypted key requires the passphrase to decrypt. Keep both safe. Without the passphrase, the private key cannot be recovered from this encrypted form.",

    // ---------- Peers ----------
    "peers.title": "Network Peers",
    "peers.status": "Status",
    "peers.connected": "Connected",
    "peers.blockHeight": "Block Height",
    "peers.network": "Network",
    "peers.mainnet": "Mainnet",
    "peers.testnet": "Testnet",
    "peers.offline": "Offline",
    "peers.syncing": "Syncing {progress}%",
    "peers.synced": "Synced",
    "peers.knownPeers": "Known Peers",
    "peers.empty.title": "No peers yet",
    "peers.empty.subtitle":
      "Peers will appear once the wallet connects to the network",
    "peers.peerCountLabel.one": "{count} peer",
    "peers.peerCountLabel.other": "{count} peers",
    "peers.addManually": "Add Peer Manually",
    "peers.dnsSeeds": "DNS Seeds",
    "peers.portLabel": "Port {port}",
    "peers.lastSeen.justNow": "Just now",
    "peers.lastSeen.minutes": "{count}m ago",
    "peers.lastSeen.hours": "{count}h ago",
    "peers.lastSeen.days": "{count}d ago",

    // Add Peer screen
    "peers.add.title": "Add Peer",
    "peers.add.description":
      "Enter the IP address and port of a {coin} node to connect to it directly. The default port is {port}.",
    "peers.add.ipLabel": "IP Address",
    "peers.add.ipPlaceholder": "192.168.1.1",
    "peers.add.portLabel": "Port",
    "peers.add.error.ipRequired": "Please enter an IP address.",
    "peers.add.error.ipInvalid":
      "Please enter a valid IPv4 address (e.g. 192.168.1.1).",
    "peers.add.error.portInvalid":
      "Please enter a valid port number (1\u201365535).",
    "peers.add.cta": "Add Peer",
    "peers.add.success.title": "Peer Added",

    // ---------- Transaction detail ----------
    "transaction.title": "Transaction",
    "transaction.details": "Details",
    "transaction.note": "Note",
    "transaction.notePlaceholder": "Add a note for this transaction...",
    "transaction.saveNote": "Save Note",
    "transaction.savedNote.title": "Saved",
    "transaction.savedNote.description": "Transaction note saved",
    "transaction.copyTxid": "Copy Transaction ID",
    "transaction.txidCopied.title": "Copied",
    "transaction.txidCopied.description": "Transaction ID copied to clipboard",
    "transaction.addressCopied.title": "Copied",
    "transaction.addressCopied.description": "Address copied to clipboard",
    "transaction.viewExplorer": "View on Explorer",
    "transaction.addToContacts": "Add Address to Contacts",
    "transaction.notFound.title": "Transaction not found",
    "transaction.notFound.subtitle": "This transaction could not be loaded",
    "transaction.goBack": "Go Back",
    "transaction.status": "Status",
    "transaction.statusValue": "{status} ({count})",
    "transaction.status.confirmed": "Confirmed",
    "transaction.status.pending": "Pending",
    "transaction.amount": "Amount",
    "transaction.txid": "Transaction ID",
    "transaction.date": "Date",
    "transaction.fee": "Fee",
    "transaction.feeIncluded": "Included in total",
    "transaction.address": "Address",
    "transaction.type.sent": "Sent",
    "transaction.type.received": "Received",
    "transaction.type.stake": "Stake",
    "transaction.type.masternodeReward": "Masternode Reward",
    "transaction.item.sent": "Sent",
    "transaction.item.received": "Received",
    "transaction.item.stake": "Staking Reward",
    "transaction.item.masternodeReward": "Masternode Reward",
    "transaction.item.paidAt": "Paid at {name}",
    "transaction.item.merchant": "a merchant",
    "transaction.item.sentToUser": "Sent to {name}",
    "transaction.item.receivedFromUser": "Received from {name}",
    "transaction.with": "With",
    "transaction.item.pending": "PENDING",
    "transaction.item.justNow": "Just now",
    "transaction.item.minutesAgo": "{count}m ago",
    "transaction.item.hoursAgo": "{count}h ago",
    "transaction.item.daysAgo": "{count}d ago",

    // ---------- QR Scanner ----------
    "qrScanner.title": "Scan QR",
    "qrScanner.subtitle": "Point camera at a FairCoin QR code",
    "qrScanner.checking": "Checking camera permission...",
    "qrScanner.permissionPrompt": "Camera access is needed to scan QR codes",
    "qrScanner.grantCta": "Grant Camera Access",
    "qrScanner.closeAccessibility": "Close scanner",
    "qrScanner.torchOnAccessibility": "Turn torch on",
    "qrScanner.torchOffAccessibility": "Turn torch off",

    // ---------- Sync Status ----------
    "syncStatus.syncing": "Syncing... {progress}%",
    "syncStatus.synced": "Synced",
    "syncStatus.blockHeight": "Block #{height}",

    // ---------- Chain / Network Status ----------
    "chain.title": "Network Status",
    "chain.group.network": "Chain",
    "chain.mainnet": "Mainnet",
    "chain.testnet": "Testnet",
    "chain.sync.offline": "Offline",
    "chain.sync.syncing": "Syncing {progress}%",
    "chain.sync.synced": "Synced",
    "chain.row.network": "Network",
    "chain.row.blockHeight": "Block Height",
    "chain.row.connectedPeers": "Connected Peers",
    "chain.row.syncProgress": "Sync Progress",
    "chain.row.lastBlock": "Last Block",
    "chain.peers.one": "{count} peer",
    "chain.peers.other": "{count} peers",
    "chain.syncProgress.value": "{progress}%",
    "chain.syncProgress.idle": "Idle",
    "chain.lastBlock.unknown": "Unknown",
    "chain.time.justNow": "Just now",
    "chain.time.minutesAgo": "{count}m ago",
    "chain.time.hoursAgo": "{count}h ago",
    "chain.time.daysAgo": "{count}d ago",
    "chain.refresh": "Refresh",

    // ---------- Wallet P2P network status ----------
    "wallet.network.offline": "Offline",
    "wallet.network.resolvingDns": "Resolving DNS seeds...",
    "wallet.network.connecting": "Connecting to peers...",
    "wallet.network.waitingForPeers": "Waiting for peers...",
    "wallet.network.searchingForPeers": "Searching for peers...",
    "wallet.network.connectedSingular": "Connected to 1 peer",
    "wallet.network.connectedPlural": "Connected to {count} peers",
    "wallet.network.error": "P2P error: {message}",

    // ---------- Balance display ----------
    "balance.change24h": "{percent}% today",

    // ---------- Language picker ----------
    "language.title": "Language",
    "language.searchPlaceholder": "Search languages...",
    "language.noResults": "No languages found",
    "language.clearSearchAccessibility": "Clear search",
    "language.selectAccessibility": "Select {name}",

    // ---------- Map / Places ----------
    "map.title": "Places that accept FairCoin",
    "map.searchPlaceholder": "Search places...",
    "map.nearYou": "Places near you",
    "map.distance": "{km} km away",
    "map.resultOne": "result",
    "map.resultOther": "results",
    "map.noResults": "No places found",
    "map.directions.accessibility": "Directions to {name}",
    "map.locateMe.accessibility": "Center on my location",
    "map.permissionDenied.title": "Location permission denied",
    "map.permissionDenied.subtitle":
      "Enable location access in your device settings to see places near you.",
    "map.webOnly.title": "Map only available on mobile",
    "map.webOnly.subtitle":
      "Open Peable on your phone to find places near you that accept FairCoin.",
    "map.unavailable.title": "Map unavailable",
    "map.unavailable.subtitle": "Map is unavailable on this device.",
    "map.category.cafe": "Cafe",
    "map.category.restaurant": "Restaurant",
    "map.category.shop": "Shop",
    "map.category.service": "Service",
    "map.category.atm": "ATM",
    "map.category.other": "Other",
    "map.filter.all": "All",
    "map.detail.directions": "Directions",
    "map.detail.share": "Share",
    "map.detail.website": "Website",
    "map.detail.call": "Call",
    "map.detail.close.accessibility": "Close details",
    "map.detail.minimumSpend": "Minimum spend",
    "map.detail.minimumSpendValue": "{amount} {ticker}",
    "map.detail.fiatExchange": "FairCoin to {currency}",
    "map.detail.fiatExchangeDescription": "Pay out FairCoin balance as {currency} here.",
    "map.detail.maxFiatPayout": "Max payout: {amount} {currency}",
    "map.detail.payoutMethod.cash": "Cash",
    "map.detail.payoutMethod.bank": "Bank transfer",
    "map.detail.payoutMethod.card": "Card load",
    "map.detail.openingHours": "Opening hours",

    // ---------- Notifications ----------
    "notifications.received.title": "Payment received",
    "notifications.received.body": "You received {amount} {ticker}",
    "notifications.sent.confirmed.title": "Payment sent",
    "notifications.sent.confirmed.body": "Your {amount} {ticker} transfer confirmed",
    "notifications.sync.title": "Syncing wallet",
    "notifications.sync.body": "{progress}% · block {block}",

    // ---------- Payment notification settings ----------
    "settings.notifications": "Payment notifications",
    "notificationsSettings.title": "Payment notifications",
    "notificationsSettings.enable.title": "Enable notifications",
    "notificationsSettings.enable.description": "Get alerted when you receive or send FAIR, even while the app is closed.",
    "notificationsSettings.server.group": "Notification server",
    "notificationsSettings.server.label": "Server URL",
    "notificationsSettings.server.hint": "Use the official Explorer, or point this at your own node for maximum privacy.",
    "notificationsSettings.server.reset": "Reset to default server",
    "notificationsSettings.confirmations.group": "Confirmations",
    "notificationsSettings.confirmations.title": "Confirmation depth",
    "notificationsSettings.confirmations.description": "Blocks before a payment counts as confirmed.",
    "notificationsSettings.confirmations.value": "{count} blocks",
    "notificationsSettings.events.group": "Events",
    "notificationsSettings.events.incomingPending": "Incoming (pending)",
    "notificationsSettings.events.incomingConfirmed": "Incoming (confirmed)",
    "notificationsSettings.events.outgoingConfirmed": "Sent (confirmed)",
  },
  es: {
    // ---------- Common ----------
    "common.ok": "OK",
    "common.cancel": "Cancelar",
    "common.save": "Guardar",
    "common.delete": "Eliminar",
    "common.confirm": "Confirmar",
    "common.error": "Error",
    "common.loading": "Cargando...",
    "common.paste": "Pegar",
    "common.copy": "Copiar",
    "common.copied": "Copiado",
    "common.done": "Listo",
    "common.back": "Atr\u00e1s",
    "common.close": "Cerrar",
    "common.retry": "Reintentar",
    "common.edit": "Editar",
    "common.import": "Importar",
    "common.create": "Crear",
    "common.switch": "Cambiar",
    "common.no": "No",
    "common.clear": "Limpiar",

    // ---------- Not found ----------
    "notFound.title": "P\u00e1gina no encontrada",
    "notFound.description": "No encontramos la pantalla que buscabas. Es posible que se haya movido o eliminado.",
    "notFound.goHome": "Volver a la billetera",

    // ---------- Public profile (/@username) ----------
    "profile.notFound.title": "Nadie usa @{username}",
    "profile.notFound.description": "Ese usuario no está registrado en Oxy. Revisa cómo se escribe o pídele su enlace.",
    "profile.error.title": "No se pudo cargar el perfil",
    "profile.error.description": "Hubo un problema al contactar con Oxy. Revisa tu conexión e inténtalo de nuevo.",
    "readOnly.title": "Has iniciado sesión en la web",
    "readOnly.subtitle": "Gastar necesita la clave de tu móvil, así que este navegador no puede enviar. Todo lo de abajo no necesita ninguna clave.",
    "readOnly.history.title": "Tus pagos de Peable",
    "readOnly.history.empty": "Todavía no hay pagos. Comparte tu código de arriba y aparecerán aquí.",
    "readOnly.history.sent": "Enviado a {name}",
    "readOnly.history.received": "Recibido de {name}",
    "readOnly.history.unknownParty": "alguien",
    "readOnly.history.unclaimed": "{amount} FAIR todavía en esta dirección",
    "readOnly.history.error": "No se pudieron cargar tus pagos. Revisa la conexión e inténtalo otra vez.",
    "readOnly.balanceNote": "Esto es lo que Peable acuñó para ti, no el saldo entero de tu monedero — ese vive en tu móvil.",
    "profile.self": "Eres tú. Comparte este código o tu enlace para que te envíen FAIR.",
    "profile.send": "Enviar FAIR a {name}",
    "profile.reserving": "Preparando dirección...",
    "profile.signIn.description": "Inicia sesión con Oxy para enviarle dinero a @{username}.",
    "profile.walletNotReady": "Termina de configurar tu billetera Peable y vuelve para pagar.",
    "profile.mainnetBlocked": "Pagar por usuario aún no está listo para mainnet, así que no puedes pagarle a @{username} desde esta billetera. Cambia a testnet en Ajustes para probarlo.",
    "profile.testnetOnly": "Pagar por usuario funciona solo en testnet por ahora.",
    "profile.web.title": "Peable vive en tu teléfono",
    "profile.web.description": "Tus claves se derivan en tu dispositivo y nunca salen de él, así que enviarle dinero a {name} se hace desde la app de Peable.",
    "profile.web.openApp": "Abrir en la app de Peable",
    "profile.error.keyless": "@{username} aún no configuró su identidad de Oxy, así que no hay a dónde enviar el dinero. Invítalo a Peable.",
    "profile.error.reserve": "No se pudo preparar una dirección de pago. Inténtalo de nuevo en un momento.",

    // ---------- Wallet / Home ----------
    "wallet.title": "Billetera",
    "wallet.balance": "Saldo Total",
    "wallet.send": "Enviar",
    "wallet.receive": "Recibir",
    "wallet.settings": "Ajustes",
    "wallet.contacts": "Contactos",
    "wallet.buy": "Comprar",
    "wallet.nodes": "Nodos",
    "wallet.places": "Lugares",
    "wallet.activity": "Actividad",
    "wallet.overview": "Resumen",
    "overview.priceChart.title": "Precio FAIR",
    "overview.priceChart.unavailable": "Datos de precio no disponibles",
    "overview.priceChart.notEnoughData": "Aún no hay suficiente historial de precios",
    "overview.priceChart.window": "Últimos 7 días",
    "overview.staking.title": "Staking y recompensas",
    "overview.staking.totalEarned": "Total ganado",
    "overview.staking.last30Days": "Últimos 30 días",
    "overview.staking.rewardsReceived": "Recompensas recibidas",
    "overview.staking.empty.title": "Aún no hay recompensas de staking",
    "overview.staking.empty.subtitle": "FairCoin recompensa a stakers y masternodes. Tus recompensas aparecerán aquí cuando lleguen.",
    "overview.network.title": "Red",
    "overview.network.blockHeight": "Altura de bloque",
    "overview.network.masternodes": "Masternodes",
    "overview.network.circulatingSupply": "Suministro circulante",
    "overview.network.unavailable": "Datos de red no disponibles",
    "wallet.date.today": "Hoy",
    "wallet.date.yesterday": "Ayer",
    "wallet.activity.empty.title": "Sin actividad a\u00fan",
    "wallet.activity.empty.subtitle": "Tus transacciones aparecer\u00e1n aqu\u00ed",
    "wallet.transactionCount.one": "{count} transacci\u00f3n",
    "wallet.transactionCount.other": "{count} transacciones",
    "wallet.syncAccessibility": "Estado de sincronizaci\u00f3n: {label}",
    "wallet.defaultName": "Peable",
    "wallet.sync.offline": "Sin conexi\u00f3n",
    "wallet.sync.syncing": "Sincronizando {progress}%",
    "wallet.sync.synced": "Sincronizado",
    "wallet.peer.one": "par",
    "wallet.peer.other": "pares",
    "wallet.block": "Bloque {height}",
    "wallet.badge.testnet": "TESTNET",

    // ---------- Send ----------
    "send.title": "Enviar FAIR",
    "send.to_address": "Direcci\u00f3n destino",
    "send.amount": "Cantidad",
    "send.fee": "Comisi\u00f3n",
    "send.total": "Total",
    "send.confirm": "Confirmar Env\u00edo",
    "send.success": "Transacci\u00f3n Enviada",
    "send.sendTo": "Enviar a",
    "send.addressPlaceholder": "Direcci\u00f3n FairCoin",
    "send.amountPlaceholder": "0",
    "send.available": "Disponible: {amount} FAIR",
    "send.usdApprox": "\u2248 ${amount} USD",
    "send.max": "MAX",
    "send.maxAccessibility": "Usar saldo m\u00e1ximo",
    "send.paste": "Pegar",
    "send.scanQR": "Escanear",
    "backup.banner.title": "Haz una copia de tu wallet",
    "backup.banner.required": "Requerido",
    "backup.banner.subtitle":
      "Configura un plan de recuperación por si pierdes el móvil o cambias de teléfono.",
    "suggest.notifications.title": "Alertas de pagos",
    "suggest.notifications.subtitle":
      "Activa las notificaciones para enterarte al instante cuando recibes FairCoin.",
    "send.contacts": "Contactos",
    "send.clearRecipient": "Limpiar destinatario",
    "send.recipientMode.person": "Persona",
    "send.recipientMode.address": "Dirección",
    "send.recipientMode.choosePlaceholder": "Elige a quién pagar",
    "send.recipientMode.reserving": "Obteniendo su dirección…",
    "send.recipientMode.keyless": "@{username} aún no configuró Peable. Invítalo para recibir pagos al instante la próxima vez.",
    "send.recent": "Reciente",
    "send.networkFee": "Comisi\u00f3n de red",
    "send.fee.low": "Baja",
    "send.fee.medium": "Media",
    "send.fee.high": "Alta",
    "send.feeUnit": "{units} m\u229c",
    "send.error.addressTooShort": "Direcci\u00f3n demasiado corta",
    "send.error.invalidAddress": "Formato de direcci\u00f3n FairCoin inv\u00e1lido",
    "send.error.invalidAmount": "Cantidad inv\u00e1lida",
    "send.error.insufficientBalance": "Saldo insuficiente",
    "send.error.failedSend": "Fall\u00f3 el env\u00edo de la transacci\u00f3n",
    "send.error.clipboard": "No se pudo leer el portapapeles",
    "send.sendCta": "Enviar FAIR",
    "send.transactionSent": "Transacci\u00f3n enviada: {txid}",
    "send.sent.title": "Transacci\u00f3n Enviada",
    "send.sent.copy": "Copiar Enlace",
    "send.sent.share": "Compartir Enlace",
    "send.confirm.title": "Confirmar Transacci\u00f3n",
    "send.confirm.to": "Para",
    "send.confirm.amount": "Cantidad",
    "send.confirm.fee": "Comisi\u00f3n",
    "send.confirm.total": "Total",
    "send.confirm.cta": "Confirmar Env\u00edo",
    "send.saveContact.title": "\u00bfGuardar Contacto?",
    "send.saveContact.description": "\u00bfGuardar {address} en contactos?",
    "send.saveContact.cta": "Guardar",
    "send.watchOnly.title": "Billetera de Solo Lectura",
    "send.watchOnly.subtitle":
      "El env\u00edo est\u00e1 deshabilitado para billeteras de solo lectura. Importa la billetera completa con una frase de recuperaci\u00f3n para habilitar el env\u00edo.",

    // ---------- Approve pay ----------
    "pay.title": "Aprobar Pago",
    "pay.usdApprox": "\u2248 ${amount} USD",
    "pay.payTo": "Pagar a",
    "pay.network": "Red",
    "pay.network.mainnet": "Principal",
    "pay.network.testnet": "Prueba",
    "pay.approve": "Aprobar y Pagar",
    "pay.decline": "Rechazar",
    "pay.processing": "Firmando y transmitiendo...",
    "pay.status.broadcast.title": "Pago enviado",
    "pay.status.broadcast.subtitle": "Esperando a que se vea en la cadena...",
    "pay.status.confirming.title": "Confirmando",
    "pay.status.confirming.subtitle": "{count} confirmaci\u00f3n(es) hasta ahora...",
    "pay.status.settled.title": "Pago liquidado",
    "pay.status.settled.subtitle": "El comercio ha recibido tu pago.",
    "pay.status.failed.title": "El pago fall\u00f3",
    "pay.status.failed.subtitle": "Este pago no se pudo completar.",
    "pay.status.expired.title": "La solicitud de pago expir\u00f3",
    "pay.status.expired.subtitle": "Esta solicitud ya no es v\u00e1lida.",
    "pay.status.rejected.title": "Pago rechazado",
    "pay.status.rejected.subtitle": "El comercio rechaz\u00f3 este pago.",
    "pay.sent.signedOut":
      "Pago enviado - inicia sesi\u00f3n en Oxy para ver el estado en vivo.",
    "pay.signIn": "Iniciar sesi\u00f3n en Oxy",
    "pay.viewTransaction": "Ver transacci\u00f3n",
    "pay.invalid.title": "Solicitud de pago no v\u00e1lida",
    "pay.invalid.subtitle":
      "Este enlace de pago est\u00e1 mal formado o incompleto y no se puede pagar.",
    "pay.error.sendFailed": "No se pudo enviar el pago",
    "pay.error.networkMismatch":
      "Esta solicitud es para {requested}, pero tu billetera est\u00e1 en {active}. Cambia de red para pagar.",
    "pay.error.watchOnly":
      "Esta es una billetera de solo lectura y no puede enviar pagos.",
    "pay.error.notInitialized":
      "Tu billetera a\u00fan se est\u00e1 cargando. Int\u00e9ntalo de nuevo en un momento.",
    "pay.notice.reportFailed":
      "El pago se transmiti\u00f3, pero la pasarela no confirm\u00f3 la recepci\u00f3n. Se liquidar\u00e1 igualmente en la cadena.",
    "pay.notice.liveStatusUnavailable":
      "Pago enviado. El estado en vivo no est\u00e1 disponible ahora mismo.",
    "pay.notice.openLinkFailed": "No se pudo abrir el enlace del explorador.",

    // ---------- Buy ----------
    "buy.title": "Comprar FAIR",
    "buy.subtitle": "Recibe FairCoin en tu billetera",
    "buy.amount.label": "\u00bfCu\u00e1nto FAIR?",
    "buy.usdApprox": "\u2248 ${amount} USD",
    "buy.method.label": "Pagar con",
    "buy.payment.recommended": "Recomendado",
    "buy.payment.comingSoon": "Pr\u00f3ximamente",
    "buy.payment.usdcBase.label": "USDC en Base",
    "buy.payment.usdcBase.description": "Comisi\u00f3n m\u00ednima, ~1 minuto",
    "buy.payment.ethBase.label": "ETH en Base",
    "buy.payment.ethBase.description": "El bridge convierte autom\u00e1ticamente a USDC",
    "buy.payment.ethMainnet.label": "ETH en Ethereum",
    "buy.payment.ethMainnet.description": "Gas m\u00e1s alto, m\u00e1s lento",
    "buy.payment.btc.label": "Bitcoin",
    "buy.payment.btc.description": "Confirmaciones m\u00e1s lentas (~10-30 min)",
    "buy.payment.card.label": "Tarjeta / Apple Pay / Google Pay",
    "buy.payment.card.description": "A trav\u00e9s de un partner regulado",
    "buy.quote.networkLabel.base": "Base",
    "buy.quote.estimatedDelivery": "60-180 segundos tras confirmarse el pago",
    "buy.cta.getInstructions": "Ver instrucciones de pago",
    "buy.error.belowMinimum": "El m\u00ednimo es {min} FAIR",
    "buy.error.aboveMaximum": "El m\u00e1ximo es {max} FAIR",
    "buy.error.watchOnly":
      "Las billeteras de solo lectura no pueden derivar una direcci\u00f3n de entrega. Importa la billetera con su frase de recuperaci\u00f3n primero.",
    "buy.error.cardNotConfigured":
      "El pago con tarjeta llegar\u00e1 pronto. Reg\u00edstrate para acceso anticipado en fairco.in/contact.",
    "buy.error.poolUnavailable":
      "Cotizaci\u00f3n no disponible. Vuelve a intentarlo en un momento.",
    "buy.error.network":
      "Error de red al contactar al bridge. Comprueba tu conexi\u00f3n y reintenta.",
    "buy.error.generic": "No se pudo crear tu orden: {message}",
    "buy.disclosure":
      "FAIR es una criptomoneda. Las compras no son reembolsables. Existe riesgo de p\u00e9rdida.",
    "buy.deliveryTo": "Entregar a",
    "buy.feeBreakdown.title": "Incluye",
    "buy.feeBreakdown.bridge": "Comisi\u00f3n del bridge {bps}%",
    "buy.feeBreakdown.slippage": "Margen de deslizamiento {bps}%",
    "buy.instructions.title": "Env\u00eda tu pago",
    "buy.instructions.sendTo":
      "Env\u00eda {symbol} en {network} a esta direcci\u00f3n",
    "buy.instructions.exactAmount": "Env\u00eda exactamente",
    "buy.instructions.networkWarning":
      "Env\u00eda {symbol} solo en la red {network}. Los fondos enviados en otra red se perder\u00e1n.",
    "buy.instructions.expiresIn": "Vence en",
    "buy.instructions.copiedAddress": "Direcci\u00f3n copiada",
    "buy.instructions.copiedAmount": "Cantidad copiada",
    "buy.instructions.cancel": "Cancelar orden",
    "buy.instructions.viewTx": "Ver en el explorador",
    "buy.instructions.openCardWebview": "Abrir p\u00e1gina de pago con tarjeta",
    "buy.status.awaiting.title": "Esperando el pago",
    "buy.status.awaiting.subtitle":
      "Env\u00eda la cantidad de arriba; lo detectaremos autom\u00e1ticamente.",
    "buy.status.detected.title": "Pago recibido",
    "buy.status.detected.subtitle": "Confirmando en la red...",
    "buy.status.swapping.title": "Intercambiando en Uniswap",
    "buy.status.swapping.subtitle": "Convirtiendo tu pago a FAIR",
    "buy.status.burning.title": "Pasando por el bridge a FairCoin",
    "buy.status.burning.subtitle":
      "Quemando WFAIR con tu direcci\u00f3n adjunta",
    "buy.status.delivering.title": "Entregando FAIR",
    "buy.status.delivering.subtitle":
      "Difundiendo en la red FairCoin...",
    "buy.status.delivered.title": "FAIR entregado",
    "buy.status.delivered.subtitle":
      "Tu FAIR ha llegado. Toca abajo para ver la transacci\u00f3n.",
    "buy.status.expired.title": "Cotizaci\u00f3n caducada",
    "buy.status.expired.subtitle":
      "Tu ventana de pago se cerr\u00f3 sin recibir dep\u00f3sito. Empieza una nueva orden para una cotizaci\u00f3n fresca.",
    "buy.status.failed.title": "Algo sali\u00f3 mal",
    "buy.status.failed.subtitle":
      "Tuvimos un problema procesando tu pago. Contacta con soporte si enviaste fondos.",

    // ---------- Receive ----------
    "receive.title": "Recibir FAIR",
    "receive.payMeAt": "P\u00e1game en",
    "receive.copy": "Copiar Direcci\u00f3n",
    "receive.share": "Compartir",
    "receive.new_address": "Nueva Direcci\u00f3n",
    "receive.subtitle": "Comparte esta direcci\u00f3n para recibir FairCoin",
    "receive.yourAddress": "Tu direcci\u00f3n",
    "receive.addressCopied.title": "Copiado",
    "receive.addressCopied.description": "Direcci\u00f3n copiada al portapapeles",
    "receive.hideList": "Ocultar lista",
    "receive.allAddresses": "Todas ({count})",
    "receive.generating": "Generando direcci\u00f3n de recepci\u00f3n...",
    "receive.paymentRequestTitle": "Solicitud de Pago FairCoin",
    "receive.shareMessage": "P\u00e1game con FairCoin:\n{uri}",

    // ---------- Settings ----------
    "settings.title": "Ajustes",
    "settings.contacts": "Contactos",
    "settings.security": "Seguridad",
    "settings.network": "Red",
    "settings.backup": "Respaldo",
    "settings.advanced": "Avanzado",
    "settings.about": "Acerca de",
    "settings.wipe": "Borrar Billetera",
    "settings.change_pin": "Cambiar PIN",
    "settings.biometrics": "Desbloqueo Biom\u00e9trico",
    "settings.show_phrase": "Mostrar Frase de Recuperaci\u00f3n",
    "settings.auto_lock": "Bloqueo Autom\u00e1tico",
    "settings.currency": "Moneda de Visualizaci\u00f3n",
    "settings.appearance": "Apariencia",
    "settings.appearance.light": "Claro",
    "settings.appearance.dark": "Oscuro",
    "settings.appearance.system": "Sistema",
    "settings.language.title": "Idioma",
    "settings.walletsGroup": "Billeteras",
    "settings.autoLockValue": "{minutes} min",
    "settings.exportKey": "Exportar Clave Cifrada",
    "settings.mainnet": "Mainnet",
    "settings.testnet": "Testnet",
    "settings.networkStatus": "Estado de Red",
    "settings.connectedPeers": "Pares Conectados",
    "settings.resync": "Resincronizar Billetera",
    "settings.exportBackup": "Exportar Respaldo",
    "settings.importBackup": "Importar Respaldo",
    "settings.coinControl": "Control de Monedas",
    "settings.masternode": "Masternode",
    "settings.aboutApp": "Acerca de Peable",
    "settings.version": "v{version}",
    "settings.dangerZone": "Zona de Peligro",
    "settings.pin.verify": "Verificar PIN",
    "settings.pin.enterCurrent": "Ingresar PIN Actual",
    "settings.pin.enterDescription": "Ingresa tu PIN de 6 d\u00edgitos",
    "settings.pin.wrong": "PIN incorrecto. Int\u00e9ntalo de nuevo.",
    "settings.pin.verificationFailed": "Fall\u00f3 la verificaci\u00f3n. Int\u00e9ntalo de nuevo.",
    "settings.recovery.title": "Frase de Recuperaci\u00f3n",
    "settings.recovery.description":
      "Mant\u00e9n estas palabras seguras y nunca las compartas.",
    "settings.recovery.error.retrieve":
      "No se pudo recuperar la frase de recuperaci\u00f3n.",
    "settings.recovery.error.load":
      "Fall\u00f3 la carga de la frase de recuperaci\u00f3n.",
    "settings.biometrics.unavailable.title": "Biometr\u00eda No Disponible",
    "settings.biometrics.unavailable.description":
      "Tu dispositivo no tiene autenticaci\u00f3n biom\u00e9trica configurada. Por favor, actívala en los ajustes del dispositivo primero.",
    "settings.biometrics.verifyPrompt": "Verifica biometr\u00eda para activar",
    "settings.biometrics.updateError":
      "Fall\u00f3 la actualizaci\u00f3n del ajuste biom\u00e9trico.",
    "settings.backup.exportDialogTitle": "Guardar respaldo de Peable",
    "settings.backup.saved.title": "Respaldo guardado",
    "settings.backup.saved.description":
      "Guardado en {path}. Compartir no est\u00e1 disponible en esta plataforma.",
    "settings.backup.exportFailed": "Fall\u00f3 la exportaci\u00f3n",
    "settings.backup.importEmpty": "El archivo seleccionado est\u00e1 vac\u00edo.",
    "settings.backup.imported.title": "Respaldo Importado",
    "settings.backup.imported.description":
      "Contactos, etiquetas y ajustes han sido restaurados.",
    "settings.backup.importFailed": "Fall\u00f3 la importaci\u00f3n",
    "settings.wipe.title": "\u00bfBorrar Billetera?",
    "settings.wipe.description":
      "Esto eliminar\u00e1 permanentemente todas las billeteras de este dispositivo. Aseg\u00farate de tener respaldadas tus frases de recuperaci\u00f3n. Esta acci\u00f3n no se puede deshacer.",
    "settings.wipe.cta": "Borrar Todas las Billeteras",
    "settings.switchNetwork.title": "Cambiar Red",
    "settings.switchNetwork.description":
      "\u00bfCambiar a {target}? Esto requerir\u00e1 una resincronizaci\u00f3n.",
    "settings.switchNetwork.cta": "Cambiar",
    "settings.resync.title": "Resincronizar Billetera",
    "settings.resync.description":
      "Esto volver\u00e1 a descargar todos los datos de la cadena de bloques.",
    "settings.resync.cta": "Resincronizar",
    "settings.resync.failed":
      "La resincronizaci\u00f3n fall\u00f3. Int\u00e9ntalo de nuevo cuando tengas pares conectados.",

    // ---------- Contacts ----------
    "contacts.title": "Contactos",
    "contacts.add": "Agregar Contacto",
    "contacts.edit": "Editar Contacto",
    "contacts.empty": "Sin contactos a\u00fan",
    "contacts.search": "Buscar contactos...",
    "contacts.searchPill": "Buscar contactos",
    "contacts.newContact": "Nuevo contacto",
    "contacts.saveAccessibility": "Guardar contacto",
    "contacts.closeAccessibility": "Cerrar",
    "contacts.backAccessibility": "Atr\u00e1s",
    "contacts.addAccessibility": "Agregar contacto",
    "contacts.clearSearchAccessibility": "Limpiar b\u00fasqueda",
    "contacts.pasteAccessibility": "Pegar direcci\u00f3n desde portapapeles",
    "contacts.scanAccessibility": "Escanear direcci\u00f3n desde c\u00f3digo QR",
    "contacts.field.name": "Nombre",
    "contacts.field.namePlaceholder": "Nombre del contacto",
    "contacts.field.address": "Direcci\u00f3n",
    "contacts.field.addressPlaceholder": "Direcci\u00f3n FairCoin",
    "contacts.field.notes": "Notas",
    "contacts.field.notesPlaceholder": "Notas opcionales",
    "contacts.emptySearch": "Ning\u00fan contacto coincide con tu b\u00fasqueda",
    "contacts.emptyAddOne": "Agrega uno para empezar",
    "contacts.clipboardError.title": "Error de Portapapeles",
    "contacts.clipboardError.description": "No se pudo leer del portapapeles.",
    "contacts.copyAddress": "Copiar Direcci\u00f3n",
    "contacts.delete.title": "Eliminar Contacto",
    "contacts.delete.description":
      "\u00bfEst\u00e1s seguro de eliminar \"{name}\"?",

    // ---------- Contact Picker ----------
    "contactPicker.title": "Seleccionar Contacto",
    "contactPicker.searchPlaceholder": "Buscar contactos...",
    "contactPicker.emptySearch": "Ning\u00fan contacto coincide con tu b\u00fasqueda",
    "contactPicker.empty": "Sin contactos a\u00fan. Agrega uno para empezar.",

    // ---------- Social Recipient Picker ----------
    "socialRecipientPicker.title": "Pagar a una persona",
    "socialRecipientPicker.searchPlaceholder": "Buscar por usuario o nombre",
    "socialRecipientPicker.prompt": "Busca a alguien para pagarle",
    "socialRecipientPicker.empty": "Nadie encontrado",

    // ---------- Onboarding ----------
    "onboarding.logoAccessibility": "Logo de Peable",
    "onboarding.signInTitle": "Bienvenido a Peable",
    "onboarding.signInSubtitle": "Inicia sesi\u00f3n con tu cuenta Oxy \u2014 tu dinero ya est\u00e1 ah\u00ed.",
    "onboarding.createIdentityTitle": "Configura tu Oxy ID",
    "onboarding.createIdentitySubtitle": "Tu monedero est\u00e1 protegido por tu identidad Oxy. Cr\u00e9ala para continuar.",
    "onboarding.createIdentityCta": "Continuar en Commons",
    "onboarding.commonsNotInstalled": "Commons by Oxy no est\u00e1 instalada en este dispositivo. Inst\u00e1lala para configurar tu Oxy ID.",
    "onboarding.createIdentityError": "No se pudo conectar con Oxy. Comprueba tu conexi\u00f3n e int\u00e9ntalo de nuevo.",
    "onboarding.webFallbackTitle": "Abre Peable en tu tel\u00e9fono",
    "onboarding.webFallbackSubtitle": "Gastar necesita las claves de tu dispositivo. Vuelve a iniciar sesi\u00f3n o abre la app.",

    // PIN setup
    "onboarding.pin_setup": "Establecer un PIN",
    "onboarding.pin_confirm": "Confirmar PIN",
    "onboarding.pin.create.title": "Crea un c\u00f3digo",
    "onboarding.pin.create.subtitle": "Este c\u00f3digo proteger\u00e1 tu billetera",
    "onboarding.pin.confirm.title": "Confirma tu c\u00f3digo",
    "onboarding.pin.confirm.subtitle": "Reingresa tu c\u00f3digo para confirmar",
    "onboarding.pin.mismatch":
      "Los c\u00f3digos no coinciden. Int\u00e9ntalo de nuevo.",
    "onboarding.pin.saveError": "Fall\u00f3 el guardado del PIN",

    // ---------- Lock screen ----------
    "lock.title": "Ingresa tu PIN",
    "lock.biometric": "Usa biometr\u00eda para desbloquear",
    "lock.enterPasscode": "Ingresa tu c\u00f3digo",
    "lock.unlockPrompt": "Desbloquear {app}",
    "lock.lockedFor": "Bloqueado por {seconds}s",
    "lock.tooManyAttempts":
      "Demasiados intentos. Int\u00e9ntalo de nuevo en {seconds}s.",
    "lock.wrongPasscode.one":
      "C\u00f3digo incorrecto. Queda {count} intento.",
    "lock.wrongPasscode.other":
      "C\u00f3digo incorrecto. Quedan {count} intentos.",
    "lock.verificationFailed":
      "Fall\u00f3 la verificaci\u00f3n. Int\u00e9ntalo de nuevo.",

    // ---------- Index / boot ----------
    "index.loading": "Cargando billetera...",
    "index.error.load": "Fall\u00f3 la carga de la billetera",
    "index.error.help":
      "Intenta reiniciar la app o borrar y restaurar tu billetera.",

    // ---------- Bolsillos ----------
    "pockets.title": "Bolsillos",
    "pockets.subtitle.one": "{count} bolsillo",
    "pockets.subtitle.other": "{count} bolsillos",
    "pockets.active": "Activo",
    "pockets.mainName": "Principal",
    "pockets.mainBadge": "Principal",
    "pockets.mainSubtitle": "Tu bolsillo del día a día",
    "pockets.switcherTitle": "Cambiar de bolsillo",
    "pockets.manage": "Gestionar bolsillos",
    "pockets.total.label": "Total en tus bolsillos",
    "pockets.yourPockets": "Tus bolsillos",
    "pockets.moveLink": "Mover dinero →",
    "pockets.createCta": "Nuevo bolsillo",
    "pockets.create.subtitle": "Aparta dinero para un objetivo",
    "pockets.create.title": "Nuevo bolsillo",
    "pockets.create.lead":
      "Una pocket es un saldo aparte dentro de tu wallet. Sigue siendo tuyo (self-custody), solo organizado.",
    "pockets.create.nameLabel": "NOMBRE DEL BOLSILLO",
    "pockets.create.namePlaceholder": "p. ej. Ahorros",
    "pockets.create.emojiLabel": "EMOJI",
    "pockets.create.colorLabel": "COLOR",
    "pockets.create.goalLabel": "OBJETIVO (OPCIONAL)",
    "pockets.create.goalPlaceholder": "0.00",
    "pockets.create.cta": "Crear bolsillo",
    "pockets.create.error.nameRequired": "Ingresa un nombre para el bolsillo",
    "pockets.create.error.invalidGoal": "Ingresa un objetivo válido",
    "pockets.create.error.failed": "No se pudo crear el bolsillo",
    "pockets.edit.title": "Editar bolsillo",
    "pockets.edit.action": "Editar",
    "pockets.edit.cta": "Guardar cambios",
    "pockets.edit.error.failed": "No se pudo guardar el bolsillo",
    "pockets.delete.title": "¿Eliminar bolsillo?",
    "pockets.delete.description": "¿Quitar \"{name}\" de tus bolsillos?",
    "pockets.delete.notEmpty":
      "Mueve los fondos fuera de este bolsillo antes de eliminarlo.",
    "pockets.delete.cannotMain": "El bolsillo principal no se puede eliminar.",
    "pockets.goal.progress": "{current} de {target} FAIR",
    "pockets.move.title": "Mover entre bolsillos",
    "pockets.move.fromLabel": "DESDE",
    "pockets.move.toLabel": "HASTA",
    "pockets.move.to": "BOLSILLO DESTINO",
    "pockets.move.amountLabel": "CANTIDAD",
    "pockets.move.cta": "Mover",
    "pockets.move.ctaAmount": "Mover {amount} FAIR",
    "pockets.move.max": "Máx",
    "pockets.move.sameAccount": "Elige un bolsillo destino diferente.",
    "pockets.move.failed": "No se pudieron mover los fondos",
    "pockets.move.noDestinations.title": "Aún no hay otros bolsillos",
    "pockets.move.noDestinations.subtitle":
      "Crea otro bolsillo primero y luego vuelve aquí para mover fondos.",
    "pockets.detail.move": "Mover",
    "pockets.detail.add": "Añadir fondos",
    "pockets.detail.switch": "Cambiar",
    "pockets.detail.manageAction": "Gestionar",
    "pockets.detail.activityUnavailable.title": "Cambia para ver la actividad",
    "pockets.detail.activityUnavailable.subtitle":
      "Aquí solo se muestra la actividad del bolsillo activo.",
    "pockets.watchOnly.title": "Billetera de Solo Lectura",
    "pockets.watchOnly.subtitle":
      "Los bolsillos no están disponibles en billeteras de solo lectura. Importa la billetera completa con una frase de recuperación para usar los bolsillos.",

    // ---------- Coin Control ----------
    "coinControl.title": "Control de Monedas",
    "coinControl.subtitle.one": "{count} UTXO disponible",
    "coinControl.subtitle.other": "{count} UTXOs disponibles",
    "coinControl.selectAll": "Seleccionar Todo",
    "coinControl.clear": "Limpiar",
    "coinControl.unspentOutputs": "Salidas No Gastadas",
    "coinControl.empty.title": "Sin salidas no gastadas",
    "coinControl.empty.subtitle": "No se encontraron UTXOs en esta billetera",
    "coinControl.selected.one": "Seleccionado: {count} UTXO",
    "coinControl.selected.other": "Seleccionados: {count} UTXOs",
    "coinControl.useCta.one":
      "Usar {count} UTXO para la Pr\u00f3xima Transacci\u00f3n",
    "coinControl.useCta.other":
      "Usar {count} UTXOs para la Pr\u00f3xima Transacci\u00f3n",
    "coinControl.selectCta": "Seleccionar UTXOs",
    "coinControl.applied.title": "Control de Monedas",
    "coinControl.applied.description.one":
      "{count} UTXO seleccionado para la pr\u00f3xima transacci\u00f3n.",
    "coinControl.applied.description.other":
      "{count} UTXOs seleccionados para la pr\u00f3xima transacci\u00f3n.",

    // ---------- Masternode ----------
    "masternode.title": "Masternode",
    "masternode.requirements.title": "Requisitos de Masternode",
    "masternode.requirements.description":
      "Un masternode de FairCoin requiere exactamente 5,000 FAIR como colateral en una sola UTXO. El colateral debe tener al menos 15 confirmaciones. Ejecutar un masternode te otorga recompensas adicionales por apoyar la red.",
    "masternode.candidates": "Candidatos de Colateral",
    "masternode.empty.title": "Sin UTXOs elegibles",
    "masternode.empty.subtitle":
      "Env\u00eda exactamente 5,000 FAIR a una de tus direcciones para crear un colateral de masternode",
    "masternode.broadcasting": "Transmitiendo...",
    "masternode.startCta": "Iniciar Masternode",
    "masternode.waiting":
      "Esperando al menos 15 confirmaciones en una UTXO de colateral",
    "masternode.ipModal.title": "Direcci\u00f3n IP del Masternode",
    "masternode.ipModal.description":
      "Ingresa la IP:puerto de tu servidor masternode (p.ej. 203.0.113.50:46372)",
    "masternode.ipModal.placeholder": "203.0.113.50:46372",
    "masternode.ipModal.error.empty": "Por favor, ingresa una direcci\u00f3n IP:puerto.",
    "masternode.ipModal.error.invalid":
      "Por favor, ingresa un IPv4:puerto v\u00e1lido (p.ej. 203.0.113.50:46372).",
    "masternode.notReady.title": "No Est\u00e1 Listo",
    "masternode.notReady.description":
      "No se encontr\u00f3 una UTXO de colateral con al menos 15 confirmaciones.",
    "masternode.confirm.title": "Confirmar Inicio de Masternode",
    "masternode.confirm.collateral": "Colateral:",
    "masternode.confirm.address": "Direcci\u00f3n:",
    "masternode.confirm.confirmations": "Confirmaciones:",
    "masternode.confirm.ip": "IP del Masternode:",
    "masternode.confirm.note":
      "Esto transmitir\u00e1 un anuncio de masternode a la red.",
    "masternode.broadcastSent.title": "Transmisi\u00f3n de Masternode Enviada",
    "masternode.broadcastSent.description":
      "La transmisi\u00f3n del masternode para {ip}:{port} ha sido encolada. Puede tardar unos minutos hasta que la red reconozca tu masternode.",
    "masternode.notAvailable.title": "A\u00fan No Disponible",
    "masternode.notAvailable.description":
      "Iniciar un masternode requiere transmitir un anuncio firmado por la red P2P de FairCoin, algo que esta billetera todav\u00eda no admite. Puedes preparar el colateral ahora; el inicio de masternode se habilitar\u00e1 en una actualizaci\u00f3n futura.",
    "masternode.notAvailableBadge": "Pr\u00f3ximamente",

    // ---------- Export Key ----------
    "exportKey.verifyPin.title": "Verificar PIN",
    "exportKey.verifyPin.subtitle":
      "Ingresa tu PIN para acceder a la exportaci\u00f3n de clave privada",
    "exportKey.verifyPin.wrong": "PIN incorrecto. Int\u00e9ntalo de nuevo.",
    "exportKey.verifyPin.failed": "Fall\u00f3 la verificaci\u00f3n.",
    "exportKey.select.title": "Seleccionar Direcci\u00f3n",
    "exportKey.select.subtitle":
      "Elige la direcci\u00f3n cuya clave privada quieres exportar",
    "exportKey.select.empty.title": "No se encontraron direcciones",
    "exportKey.select.empty.subtitle":
      "No hay direcciones disponibles para exportaci\u00f3n de clave",
    "exportKey.passphrase.title": "Establecer Frase de Cifrado",
    "exportKey.passphrase.subtitle":
      "Esta frase ser\u00e1 necesaria para descifrar la clave exportada. Elige una frase fuerte y gu\u00e1rdala de manera segura.",
    "exportKey.passphrase.label": "Frase de paso",
    "exportKey.passphrase.placeholder": "Ingresa frase (m\u00edn 8 caracteres)",
    "exportKey.passphrase.confirmLabel": "Confirmar Frase",
    "exportKey.passphrase.confirmPlaceholder": "Confirma la frase",
    "exportKey.passphrase.error.tooShort":
      "La frase debe tener al menos 8 caracteres",
    "exportKey.passphrase.error.mismatch": "Las frases no coinciden",
    "exportKey.passphrase.encrypting": "Cifrando...",
    "exportKey.passphrase.encryptCta": "Cifrar Clave Privada",
    "exportKey.error.noMnemonic":
      "No se pudo acceder a la frase mnem\u00f3nica de la billetera.",
    "exportKey.error.noPrivateKey":
      "No se pudo encontrar la clave privada para esta direcci\u00f3n.",
    "exportKey.error.encryptionFailed": "Fall\u00f3 el cifrado",
    "exportKey.result.title": "Clave Cifrada",
    "exportKey.result.subtitle": "Tu clave privada cifrada BIP38",
    "exportKey.result.copyCta": "Copiar Clave Cifrada",
    "exportKey.result.copied.title": "Copiado",
    "exportKey.result.copied.description":
      "Clave cifrada copiada al portapapeles",
    "exportKey.warning.title": "Importante",
    "exportKey.warning.description":
      "Esta clave cifrada requiere la frase para descifrar. Mant\u00e9n ambas seguras. Sin la frase, la clave privada no puede recuperarse de esta forma cifrada.",

    // ---------- Peers ----------
    "peers.title": "Pares de Red",
    "peers.status": "Estado",
    "peers.connected": "Conectado",
    "peers.blockHeight": "Altura de Bloque",
    "peers.network": "Red",
    "peers.mainnet": "Mainnet",
    "peers.testnet": "Testnet",
    "peers.offline": "Sin conexi\u00f3n",
    "peers.syncing": "Sincronizando {progress}%",
    "peers.synced": "Sincronizado",
    "peers.knownPeers": "Pares Conocidos",
    "peers.empty.title": "Sin pares a\u00fan",
    "peers.empty.subtitle":
      "Los pares aparecer\u00e1n cuando la billetera se conecte a la red",
    "peers.peerCountLabel.one": "{count} par",
    "peers.peerCountLabel.other": "{count} pares",
    "peers.addManually": "Agregar Par Manualmente",
    "peers.dnsSeeds": "Semillas DNS",
    "peers.portLabel": "Puerto {port}",
    "peers.lastSeen.justNow": "Ahora mismo",
    "peers.lastSeen.minutes": "hace {count}m",
    "peers.lastSeen.hours": "hace {count}h",
    "peers.lastSeen.days": "hace {count}d",

    // Add Peer screen
    "peers.add.title": "Agregar Par",
    "peers.add.description":
      "Ingresa la direcci\u00f3n IP y puerto de un nodo {coin} para conectarte directamente. El puerto predeterminado es {port}.",
    "peers.add.ipLabel": "Direcci\u00f3n IP",
    "peers.add.ipPlaceholder": "192.168.1.1",
    "peers.add.portLabel": "Puerto",
    "peers.add.error.ipRequired": "Por favor, ingresa una direcci\u00f3n IP.",
    "peers.add.error.ipInvalid":
      "Por favor, ingresa una direcci\u00f3n IPv4 v\u00e1lida (p.ej. 192.168.1.1).",
    "peers.add.error.portInvalid":
      "Por favor, ingresa un n\u00famero de puerto v\u00e1lido (1\u201365535).",
    "peers.add.cta": "Agregar Par",
    "peers.add.success.title": "Par Agregado",

    // ---------- Transaction detail ----------
    "transaction.title": "Transacci\u00f3n",
    "transaction.details": "Detalles",
    "transaction.note": "Nota",
    "transaction.notePlaceholder": "Agrega una nota para esta transacci\u00f3n...",
    "transaction.saveNote": "Guardar Nota",
    "transaction.savedNote.title": "Guardado",
    "transaction.savedNote.description": "Nota de transacci\u00f3n guardada",
    "transaction.copyTxid": "Copiar ID de Transacci\u00f3n",
    "transaction.txidCopied.title": "Copiado",
    "transaction.txidCopied.description":
      "ID de transacci\u00f3n copiado al portapapeles",
    "transaction.addressCopied.title": "Copiado",
    "transaction.addressCopied.description":
      "Direcci\u00f3n copiada al portapapeles",
    "transaction.viewExplorer": "Ver en Explorador",
    "transaction.addToContacts": "Agregar Direcci\u00f3n a Contactos",
    "transaction.notFound.title": "Transacci\u00f3n no encontrada",
    "transaction.notFound.subtitle": "Esta transacci\u00f3n no pudo ser cargada",
    "transaction.goBack": "Volver",
    "transaction.status": "Estado",
    "transaction.statusValue": "{status} ({count})",
    "transaction.status.confirmed": "Confirmada",
    "transaction.status.pending": "Pendiente",
    "transaction.amount": "Cantidad",
    "transaction.txid": "ID de Transacci\u00f3n",
    "transaction.date": "Fecha",
    "transaction.fee": "Comisi\u00f3n",
    "transaction.feeIncluded": "Incluida en el total",
    "transaction.address": "Direcci\u00f3n",
    "transaction.type.sent": "Enviada",
    "transaction.type.received": "Recibida",
    "transaction.type.stake": "Stake",
    "transaction.type.masternodeReward": "Recompensa Masternode",
    "transaction.item.sent": "Enviada",
    "transaction.item.received": "Recibida",
    "transaction.item.stake": "Recompensa de Staking",
    "transaction.item.masternodeReward": "Recompensa Masternode",
    "transaction.item.paidAt": "Pagado en {name}",
    "transaction.item.merchant": "un comercio",
    "transaction.item.sentToUser": "Enviado a {name}",
    "transaction.item.receivedFromUser": "Recibido de {name}",
    "transaction.with": "Con",
    "transaction.item.pending": "PENDIENTE",
    "transaction.item.justNow": "Ahora mismo",
    "transaction.item.minutesAgo": "hace {count}m",
    "transaction.item.hoursAgo": "hace {count}h",
    "transaction.item.daysAgo": "hace {count}d",

    // ---------- QR Scanner ----------
    "qrScanner.title": "Escanear QR",
    "qrScanner.subtitle": "Apunta la c\u00e1mara a un c\u00f3digo QR de FairCoin",
    "qrScanner.checking": "Comprobando permiso de c\u00e1mara...",
    "qrScanner.permissionPrompt":
      "Se necesita acceso a la c\u00e1mara para escanear c\u00f3digos QR",
    "qrScanner.grantCta": "Otorgar Acceso a C\u00e1mara",
    "qrScanner.closeAccessibility": "Cerrar esc\u00e1ner",
    "qrScanner.torchOnAccessibility": "Encender linterna",
    "qrScanner.torchOffAccessibility": "Apagar linterna",

    // ---------- Sync Status ----------
    "syncStatus.syncing": "Sincronizando... {progress}%",
    "syncStatus.synced": "Sincronizado",
    "syncStatus.blockHeight": "Bloque #{height}",

    // ---------- Chain / Network Status ----------
    "chain.title": "Estado de Red",
    "chain.group.network": "Cadena",
    "chain.mainnet": "Mainnet",
    "chain.testnet": "Testnet",
    "chain.sync.offline": "Sin conexi\u00f3n",
    "chain.sync.syncing": "Sincronizando {progress}%",
    "chain.sync.synced": "Sincronizado",
    "chain.row.network": "Red",
    "chain.row.blockHeight": "Altura de Bloque",
    "chain.row.connectedPeers": "Pares Conectados",
    "chain.row.syncProgress": "Progreso de Sincronizaci\u00f3n",
    "chain.row.lastBlock": "\u00daltimo Bloque",
    "chain.peers.one": "{count} par",
    "chain.peers.other": "{count} pares",
    "chain.syncProgress.value": "{progress}%",
    "chain.syncProgress.idle": "Inactivo",
    "chain.lastBlock.unknown": "Desconocido",
    "chain.time.justNow": "Ahora mismo",
    "chain.time.minutesAgo": "hace {count}m",
    "chain.time.hoursAgo": "hace {count}h",
    "chain.time.daysAgo": "hace {count}d",
    "chain.refresh": "Actualizar",

    // ---------- Wallet P2P network status ----------
    "wallet.network.offline": "Sin conexión",
    "wallet.network.resolvingDns": "Resolviendo semillas DNS...",
    "wallet.network.connecting": "Conectando a pares...",
    "wallet.network.waitingForPeers": "Esperando pares...",
    "wallet.network.searchingForPeers": "Buscando pares...",
    "wallet.network.connectedSingular": "Conectado a 1 par",
    "wallet.network.connectedPlural": "Conectado a {count} pares",
    "wallet.network.error": "Error P2P: {message}",

    // ---------- Balance display ----------
    "balance.change24h": "{percent}% hoy",

    // ---------- Language picker ----------
    "language.title": "Idioma",
    "language.searchPlaceholder": "Buscar idiomas...",
    "language.noResults": "Sin resultados",
    "language.clearSearchAccessibility": "Borrar búsqueda",
    "language.selectAccessibility": "Seleccionar {name}",

    // ---------- Map / Places ----------
    "map.title": "Lugares que aceptan FairCoin",
    "map.searchPlaceholder": "Buscar lugares...",
    "map.nearYou": "Lugares cerca de ti",
    "map.distance": "a {km} km",
    "map.resultOne": "resultado",
    "map.resultOther": "resultados",
    "map.noResults": "Sin resultados",
    "map.directions.accessibility": "Cómo llegar a {name}",
    "map.locateMe.accessibility": "Centrar en mi ubicación",
    "map.permissionDenied.title": "Permiso de ubicación denegado",
    "map.permissionDenied.subtitle":
      "Activa el acceso a la ubicación en los ajustes de tu dispositivo para ver lugares cercanos.",
    "map.webOnly.title": "El mapa solo está disponible en móvil",
    "map.webOnly.subtitle":
      "Abre Peable en tu teléfono para encontrar lugares cerca de ti que acepten FairCoin.",
    "map.unavailable.title": "Mapa no disponible",
    "map.unavailable.subtitle": "El mapa no está disponible en este dispositivo.",
    "map.category.cafe": "Cafetería",
    "map.category.restaurant": "Restaurante",
    "map.category.shop": "Tienda",
    "map.category.service": "Servicio",
    "map.category.atm": "Cajero",
    "map.category.other": "Otro",
    "map.filter.all": "Todos",
    "map.detail.directions": "Cómo llegar",
    "map.detail.share": "Compartir",
    "map.detail.website": "Sitio web",
    "map.detail.call": "Llamar",
    "map.detail.close.accessibility": "Cerrar detalles",
    "map.detail.minimumSpend": "Consumo mínimo",
    "map.detail.minimumSpendValue": "{amount} {ticker}",
    "map.detail.fiatExchange": "FairCoin a {currency}",
    "map.detail.fiatExchangeDescription": "Cambia tu saldo de FairCoin por {currency} aquí.",
    "map.detail.maxFiatPayout": "Máximo: {amount} {currency}",
    "map.detail.payoutMethod.cash": "Efectivo",
    "map.detail.payoutMethod.bank": "Transferencia",
    "map.detail.payoutMethod.card": "Tarjeta",
    "map.detail.openingHours": "Horario",

    // ---------- Notifications ----------
    "notifications.received.title": "Pago recibido",
    "notifications.received.body": "Recibiste {amount} {ticker}",
    "notifications.sent.confirmed.title": "Pago enviado",
    "notifications.sent.confirmed.body": "Tu envío de {amount} {ticker} se confirmó",
    "notifications.sync.title": "Sincronizando billetera",
    "notifications.sync.body": "{progress}% · bloque {block}",

    // ---------- Ajustes de notificaciones de pago ----------
    "settings.notifications": "Notificaciones de pago",
    "notificationsSettings.title": "Notificaciones de pago",
    "notificationsSettings.enable.title": "Activar notificaciones",
    "notificationsSettings.enable.description": "Recibe alertas cuando recibas o envíes FAIR, incluso con la app cerrada.",
    "notificationsSettings.server.group": "Servidor de notificaciones",
    "notificationsSettings.server.label": "URL del servidor",
    "notificationsSettings.server.hint": "Usa el Explorer oficial, o apunta a tu propio nodo para máxima privacidad.",
    "notificationsSettings.server.reset": "Restablecer al servidor por defecto",
    "notificationsSettings.confirmations.group": "Confirmaciones",
    "notificationsSettings.confirmations.title": "Profundidad de confirmación",
    "notificationsSettings.confirmations.description": "Bloques antes de considerar un pago confirmado.",
    "notificationsSettings.confirmations.value": "{count} bloques",
    "notificationsSettings.events.group": "Eventos",
    "notificationsSettings.events.incomingPending": "Entrante (pendiente)",
    "notificationsSettings.events.incomingConfirmed": "Entrante (confirmado)",
    "notificationsSettings.events.outgoingConfirmed": "Enviado (confirmado)",
  },
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let currentLanguage: Language = "en";
let currentLocale: string = "en-US";

/**
 * Return the `TranslatedLanguage` to use for lookups given a (possibly
 * untranslated) user-chosen language code. Any code without a translation
 * table falls back to English.
 */
function resolveTranslationTable(lang: Language): TranslatedLanguage {
  return lang === "es" ? "es" : "en";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the initial language on app start.
 *
 * 1. If the user has a stored preference in secure storage, use that.
 * 2. Otherwise fall back to the device locale (if supported).
 * 3. Otherwise default to English.
 */
export async function initLanguage(): Promise<Language> {
  const locales = getLocales();
  currentLocale = locales[0]?.languageTag ?? "en-US";

  try {
    const stored = await getItemAsync(STORAGE_KEY);
    if (stored && isSupportedLanguage(stored)) {
      currentLanguage = stored;
      return currentLanguage;
    }
  } catch (error: unknown) {
    console.warn("Could not read the saved language; using the device locale", error);
  }

  const deviceLang = locales[0]?.languageCode ?? "en";
  currentLanguage = isSupportedLanguage(deviceLang) ? deviceLang : "en";
  return currentLanguage;
}

/**
 * Replace `{name}` placeholders in a template with values from params.
 * Unknown placeholders are left intact so callers see the bug rather than
 * silently losing text.
 */
function interpolate(template: string, params: TranslationParams): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = params[key];
    if (value === undefined) return match;
    return String(value);
  });
}

/**
 * Translate a key to the current language with optional `{placeholder}`
 * interpolation. Falls back to English, then returns the key itself if not
 * found.
 */
export function t(key: string, params?: TranslationParams): string {
  const table = resolveTranslationTable(currentLanguage);
  const template = translations[table][key] ?? translations.en[key] ?? key;
  if (!params) return template;
  return interpolate(template, params);
}

/**
 * Set the current language explicitly and persist the choice.
 *
 * Unsupported codes are ignored (defaults to `"en"`), so callers don't need
 * to validate before calling.
 */
export async function setLanguage(lang: Language): Promise<void> {
  const next = isSupportedLanguage(lang) ? lang : "en";
  currentLanguage = next;
  try {
    await setItemAsync(STORAGE_KEY, next);
  } catch (error: unknown) {
    console.warn("Could not persist the selected language", error);
  }
}

/**
 * Get the current language.
 */
export function getLanguage(): Language {
  return currentLanguage;
}

/** Format a number with locale-appropriate separators */
export function formatNumber(value: number, decimals: number = 2): string {
  return new Intl.NumberFormat(currentLocale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

/** Format FAIR amount from smallest units (m⊜) with locale separators */
export function formatFairAmount(value: bigint): string {
  const fair = Number(value) / Number(UNITS_PER_COIN);
  return new Intl.NumberFormat(currentLocale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8,
  }).format(fair);
}

/** Format fiat currency amount with correct symbol and formatting */
export function formatFiatAmount(amount: number, currency: string = "USD"): string {
  return new Intl.NumberFormat(currentLocale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/** Get the user's default currency code */
export function getDefaultCurrency(): string {
  const locales = getLocales();
  return locales[0]?.currencyCode ?? "USD";
}

/** Check if locale uses 24-hour clock */
export function uses24HourClock(): boolean {
  const calendars = getCalendars();
  return calendars[0]?.uses24hourClock ?? false;
}
