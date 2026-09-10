# FAIRWallet

Lightweight SPV wallet for [FairCoin](https://fairco.in) — cross-platform (Android, iOS, Desktop).

Built with Expo SDK 55, React Native 0.83, and pure TypeScript cryptography.

## Features

- **True SPV wallet** — connects directly to the FairCoin P2P network via DNS seeds, no server dependency
- **HD wallet** — BIP39 (24-word mnemonic) + BIP32 + BIP44 (`m/44'/119'/0'/...`)
- **Multi-wallet** — create, import, switch between, and manage multiple wallets
- **QR code** — camera scanner to send, QR display to receive
- **Deep links** — handles `faircoin:` URIs (BIP21-style), opens Send pre-filled
- **PIN & biometrics** — 6-digit PIN with fingerprint/face unlock on app open
- **Address book** — save and manage contacts
- **Coin control** — select specific UTXOs for transactions
- **Masternode** — detect 5,000 FAIR collateral UTXOs, start masternodes
- **BIP38** — encrypted private key export/import
- **Places map** — native MapLibre map of places that accept FairCoin, with category filters, search, minimum-spend and FairCoin-to-fiat exchange metadata per place (native-only; web shows an empty state)
- **Secure** — keys in OS keychain, per-wallet SQLite databases, edge-to-edge UI

## Platforms

| Platform | Status | Build |
|----------|--------|-------|
| Android | Production | APK via GitHub Actions |
| iOS | Production | Expo prebuild + Xcode |
| Desktop | Production | Electron (Windows, macOS, Linux) |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Expo SDK 55, React Native 0.83 |
| Navigation | expo-router with native tabs (NativeTabs on Android/iOS, headless on web) |
| Styling | NativeWind 4.x (Tailwind CSS) |
| State | Zustand 5 |
| Crypto | `@noble/secp256k1` 2.x, `@noble/hashes` 1.8, `@scure/bip32` 1.7, `@scure/bip39` 1.6 |
| Storage | expo-secure-store (native keychain), expo-sqlite (chain data) |
| P2P | Custom SPV client over TCP (react-native-tcp-socket on mobile, Node.js net on Electron) |
| Map | `@maplibre/maplibre-react-native` v10 with Carto vector tiles (no API key) |
| UI kit | `@oxy.so/bloom` (theme, prompt dialogs) |
| Lists | `@shopify/flash-list` v2 with `@gorhom/bottom-sheet` v5 integration |
| Animation | `react-native-reanimated` 4.x |
| Desktop | Electron with custom `app://` protocol for proper SPA routing |

## FairCoin Protocol

| Parameter | Value |
|-----------|-------|
| Ticker | FAIR |
| Address prefix | `35` (starts with `F`) |
| Script prefix | `16` (starts with `3`) |
| BIP44 coin type | `119` |
| P2P port | `46372` |
| Protocol version | `71000` |
| Block hash | Quark (9-round multi-hash) |
| Tx hash | Double SHA-256 |
| Signing curve | secp256k1 |
| Masternode collateral | 5,000 FAIR |
| DNS seeds | `seed1.fairco.in`, `seed2.fairco.in` |

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [Bun](https://bun.sh/) (package manager)
- JDK 17+ (for Android builds)
- Android SDK (for Android builds)

### Install

```bash
git clone https://github.com/FairCoinOfficial/FAIRWallet.git
cd FAIRWallet
bun install
```

### Development

```bash
# Start Expo dev server (requires Expo Go or dev client)
bun start

# Build and run on Android (requires Android SDK + JDK)
bun run android

# Build and run on iOS (requires Xcode)
bun run ios

# Web (for Electron development)
bun run web
```

### Desktop (Electron)

```bash
# Build web export + launch Electron
bun run export:web
bun run electron

# Development mode (connects to Expo dev server)
bun run electron -- --dev
```

### Build APK Locally

```bash
npx expo prebuild --platform android
cd android && ./gradlew assembleRelease
```

### Type Check

```bash
bun run typecheck
```

## CI/CD

GitHub Actions automatically build and attach release artifacts when you create a GitHub release:

- **Android**: APK built with Gradle, attached to release
- **Desktop**: Windows (.exe), macOS (.dmg), Linux (.deb, .AppImage) via electron-builder

```bash
# Create a release (triggers builds)
gh release create v1.0.1 --title "v1.0.1" --notes "Release notes..."
```

## Project Structure

```
FAIRWallet/
├── app/                    # Expo Router screens
│   ├── _layout.tsx         # Root layout + deep link handler
│   ├── index.tsx           # Entry (wallet check → lock/onboarding/tabs)
│   ├── lock.tsx            # PIN/biometric lock screen
│   ├── masternode.tsx      # Masternode management
│   ├── wallets.tsx         # Multi-wallet manager
│   ├── contacts.tsx        # Address book
│   ├── coin-control.tsx    # UTXO selection
│   ├── export-key.tsx      # BIP38 key export
│   ├── map.tsx             # Native places map (MapLibre + bottom sheet)
│   ├── map.web.tsx         # Web fallback (map is native-only)
│   ├── transaction/        # Transaction detail
│   ├── onboarding/         # Welcome, create, restore, PIN setup
│   └── (tabs)/             # Main app (wallet, send, receive, settings)
├── src/
│   ├── core/               # FairCoin protocol (pure TypeScript)
│   │   ├── network.ts      # Network constants (mainnet/testnet)
│   │   ├── encoding.ts     # Base58Check, BufferWriter/Reader
│   │   ├── address.ts      # Hash160, address generation
│   │   ├── hd-wallet.ts    # BIP39/BIP32/BIP44
│   │   ├── script.ts       # Bitcoin script opcodes
│   │   ├── transaction.ts  # Tx build/sign/serialize
│   │   ├── quark-hash.ts   # Quark 9-round hash (block headers)
│   │   ├── bip38.ts        # Encrypted key export/import
│   │   ├── checkpoints.ts  # Hardcoded block checkpoints
│   │   └── uri.ts          # faircoin: URI parsing (BIP21)
│   ├── p2p/                # SPV P2P client
│   │   ├── messages.ts     # Wire protocol serialization
│   │   ├── bloom-filter.ts # BIP37 Bloom filter
│   │   ├── peer.ts         # TCP peer connection + handshake
│   │   ├── peer-manager.ts # Multi-peer pool + discovery
│   │   ├── spv-client.ts   # Header sync + Merkle validation
│   │   ├── dns-seeds.ts    # DNS-over-HTTPS seed resolution
│   │   ├── masternode.ts   # Masternode broadcast/ping
│   │   ├── socket-provider.ts # Platform TCP adapter
│   │   └── header-store.ts # SQLite ↔ SPV bridge
│   ├── wallet/             # Wallet state
│   │   ├── key-manager.ts  # HD key derivation + gap limit
│   │   ├── utxo-set.ts     # UTXO tracking + coin selection
│   │   └── wallet-store.ts # Zustand store (multi-wallet, P2P)
│   ├── storage/            # Persistence
│   │   ├── database.ts     # SQLite (per-wallet)
│   │   ├── secure-store.ts # Keychain (mnemonics, PIN, biometrics)
│   │   └── kv-store.ts     # Platform adapter (native keychain / localStorage)
│   └── ui/components/      # Reusable UI
│       ├── Button.tsx
│       ├── TransactionItem.tsx
│       ├── SyncStatus.tsx
│       └── QRScanner.tsx
├── electron/               # Desktop wrapper
│   ├── main.js             # Custom app:// protocol + TCP P2P + safeStorage
│   └── preload.js          # contextBridge API
├── plugins/
│   └── withGradle813.js    # Expo config plugin: Gradle 9→8.13 downgrade
├── .github/workflows/
│   ├── build-android.yml   # APK build on release
│   └── build-desktop.yml   # Electron builds on release
└── app.json                # Expo config
```

## Deep Links

FAIRWallet handles `faircoin:` URIs following BIP21 conventions:

```
faircoin:FxxxxAddress
faircoin:FxxxxAddress?amount=10.5
faircoin:FxxxxAddress?amount=10.5&label=Donation&message=Thanks
```

Tapping a `faircoin:` link opens FAIRWallet and navigates to the Send screen with address and amount pre-filled.

## Security

- Private keys and mnemonics stored in OS keychain (iOS Keychain / Android EncryptedSharedPreferences)
- PIN hashed with SHA-256 before storage
- Each wallet has its own isolated SQLite database
- All cryptography uses audited libraries (`@noble/*`, `@scure/*`)
- No external servers — SPV client connects directly to FairCoin nodes
- BIP38 encrypted key export for backups

## License

MIT
