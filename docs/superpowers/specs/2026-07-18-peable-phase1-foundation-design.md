# Peable — Fase 1 (Cimiento): flujo de pago no-custodial end-to-end

> **Estado:** diseño para revisión. Fase 1 de un producto multi-fase (ver "Contexto"). YAGNI estricto: esto prueba **un** flujo atómico, nada más.
> **Fecha:** 2026-07-18

## Contexto

Peable pivota de una plataforma **custodial** (muerta, no funcionaba) a una **pasarela de pagos no-custodial sobre FairCoin** — "Stripe sobre FairCoin". La app se basa en un fork de **FAIRWallet** (self-custodial, SPV/P2P, `@oxy.so/bloom`) vendorizado vía `git subtree` en `packages/frontend`, con **identidad Oxy** añadida encima. FairCoin/FAIRWallet siguen siendo un proyecto **aparte** (usable sin Oxy); Peable es el hermano vinculado a la cuenta Oxy.

**Restricción legal load-bearing (MiCA):** custodiar los FairCoins convertiría a Oxy en CASP (licencia, capital, AML, auditorías). Self-custody queda **fuera** de MiCA. Por tanto la **no-custodia es un invariante de diseño, no una feature** — es el firewall legal.

Producto completo (fuera de alcance de esta fase, para orientar): **F1 cimiento** · F2 plataforma merchant/SDK `@peable.to/sdk` · F3 presencial/POS · F4 amplitud Stripe (billing/refunds/payouts). Dashboard developer = UI propia de Peable pero backend de apps/keys/tokens = **Oxy Console** (sin duplicar).

## Nomenclatura (productos)

- **Peable** — la **app monedero** (consumer): self-custody FairCoin + identidad Oxy + aprobar-pago. → `packages/frontend`.
- **Peable Gateway** — la **pasarela de pagos**: backend + API pública + SDK `@peable.to/sdk` + catálogo estilo Stripe (**one-time payments, payment links, invoices, subscriptions, checkout, webhooks**), integrable por apps del ecosistema Oxy (**Mercaria**, etc.) **y por terceros** que quieran Peable como su pasarela. → `packages/backend` + `shared-types` + `PeableSDK`. Registro de apps/keys/tokens vía **Oxy Console**; **dashboard propio** estilo Stripe.
- **Peable Terminal** — el **TPV**: terminal merchant (NFC, móvil/PC), app Expo aparte. → `packages/terminal`.
- **FairWallet** — proyecto **aparte** (sin Oxy). Peable es el hermano vinculado a Oxy.

**Catálogo Stripe → fases** (el gateway crece sobre el primitivo de F1):
- **one-time payment** = el primitivo de F1 (el `PaymentIntent`).
- **payment links / checkout / SDK embebible** = F2.
- **invoices** = F2/F4.
- **subscriptions** = F4 (no-custodial difícil sobre UTXO: per-approval o pre-firma nLockTime — ya analizado).

## Objetivo de la Fase 1

Probar, end-to-end en **testnet FairCoin**, la unidad atómica sobre la que se apoya todo:

> **cobro → notificación → aprobación → firma self-custody → liquidación FairCoin → confirmación + webhook**

Un merchant (autenticado con app-key emitida por Console) crea un cobro; un usuario Peable lo aprueba y **firma él mismo** el pago; el backend **observa** la cadena (watch-only) y confirma; se dispara un webhook. Oxy **nunca** tiene claves ni toca fondos.

## Invariante de no-custodia (obligatorio, verificable)

Todo el diseño respeta, sin excepción:
1. Las claves privadas viven **solo** en el dispositivo del usuario (secure-store, BIP44). El backend nunca las ve, guarda ni deriva.
2. El backend nunca posee ni controla fondos, ni transitoriamente. No hay balance custodial, ni "cuenta Peable" con saldo.
3. El pago lo **inicia y firma el usuario**. El backend solo: crea intents, rutea notificaciones, **observa** direcciones (watch-only, solo claves públicas/xpub), confirma, dispara webhooks, contabilidad merchant.
4. Del merchant el backend guarda como mucho un **xpub watch-only** (clave pública → no puede gastar).

Un cambio que viole 1-4 es un bug legal, no solo técnico.

## Principios transversales (todo el Gateway)

- **Realtime-first:** sistema event-driven. Cada cambio de estado del `PaymentIntent` se propaga **al instante vía Socket.io** a todos los interesados (monedero del pagador, SDK/dashboard del merchant, Peable Terminal). REST para comandos, **sockets para estado** — nada de polling en el camino crítico.
- **Todo interconectado:** el `PaymentIntent` es la **única fuente de verdad**; app, gateway, SDK, terminal y webhooks observan el mismo objeto/eventos.
- **Paridad con Stripe (API/SDK/estructura):**
  - Objetos-recurso con **IDs prefijados**: `pi_` (PaymentIntent), `evt_` (Event); en fases posteriores `link_`, `cs_` (checkout session), `in_` (invoice), `sub_` (subscription), `merch_`/`acct_`.
  - **`Idempotency-Key`** en todos los `create`.
  - Versionado de API por fecha vía header **`Peable-Version`**.
  - Webhooks con **firma HMAC** y tipos punteados (`payment_intent.settled`, `payment_intent.failed`, …) — como Stripe (`payment_intent.succeeded`).
  - Referencia tipo **`client_secret`** para que el cliente (monedero) resuelva/confirme el intent; aquí "confirmar" = **aprobar + firmar** self-custody.
  - **SDK ergonómico namespaced:** `peable.paymentIntents.create(...)`, `.retrieve(id)`, `.list(...)`; paginación y `expand` estilo Stripe.
  - **test / live mode** por app-key (emitidas por Console).
- **Código:** limpio, eficiente, **bien-acotado** (módulos de una responsabilidad, interfaces claras, imports directos, tipos correctos). **Sin hacks / tricky things / `as any` / shims** (estándares de AGENTS.md).

## Alcance

**Dentro (F1):**
- App: fork FAIRWallet en `packages/frontend` + `OxyProvider` (identidad Oxy vinculada) + pantalla **aprobar-pago** + bandeja de payment-requests + manejo de push.
- Backend nuevo de cero (`packages/backend`): modelo `PaymentIntent`, registro merchant (xpub watch-only + endpoint webhook), API de intents, **watcher de liquidación** (watch-only vía Explorer), dispatcher de webhooks, auth `@oxy.so/core/server`, Socket.io para updates realtime del intent al monedero.
- `shared-types`: DTOs `PaymentIntent`, enum de estados, tipos de evento webhook.

**Fuera (fases posteriores):** SDK `@peable.to/sdk`, dashboard en Console, POS/tap-to-pay, suscripciones/recurrencia, on/off-ramp fiat, refunds, payouts, multi-merchant a escala, antifraude.

## Arquitectura

**Actores:** Payee (merchant / app Oxy) · Payer (usuario Peable) · Backend Peable (orquestador) · Cadena FairCoin (+ Explorer para watch-only).

**Repos/paquetes tocados en F1:** solo `Peable/packages/{frontend,backend,shared-types}`. (Console/SDK/POS = fases siguientes.)

### Ciclo de vida de `PaymentIntent`

```
created → awaiting_approval → approved → broadcast → confirming → settled
                    │              │                                  
                    ├─ rejected (usuario declina)                     
                    ├─ expired (TTL sin aprobar)                      
                    └─ failed (underpaid / reorg / broadcast error)   
```

- `created` — merchant llamó a la API; el backend derivó una **dirección de recepción fresca** del xpub del merchant y la asoció al intent.
- `awaiting_approval` — entregado al payer (push si se conoce el usuario Oxy; o abierto vía QR/link).
- `approved` → `broadcast` — el usuario aprobó; el **wallet** construyó, firmó y difundió la tx (coin-selection ya existe en FAIRWallet).
- `confirming` — el watcher ve la tx en mempool a la dirección del intent, importe correcto.
- `settled` — alcanzadas N confirmaciones (config por merchant; default 1 en testnet). Dispara webhook.
- Estados de fallo con su semántica (expiry TTL, underpayment, reorg-rewind → vuelve a confirming/failed).

### Emparejar tx ↔ intent (decisión de diseño)

**Elegido: dirección fresca por intent, derivada de un xpub watch-only del merchant (estilo BTCPay).**
- El merchant registra **un xpub de cuenta** (BIP44, p.ej. `m/44'/119'/account'`). Público → el backend **no puede gastar** (no-custodial ✔).
- Por cada intent el backend deriva la siguiente dirección externa (`.../0/index`) y guarda el índice. La tx se empareja por **dirección única**, no por importe → sin colisiones.
- *Fallback solo para el primer smoke test:* dirección estática + importe único con nonce en las unidades bajas. Se descarta en cuanto el xpub funcione.

Derivación reutiliza `@fairco.in/core` (`encodeAddress`) + `@scure/bip32`, igual que `packages/frontend/src/wallet/key-manager.ts`.

### Observación de liquidación (txid reportado + verificación — hallazgo 2026-07-18)

El backend **no corre custodia ni nodo propio**. Se probó el Explorer en vivo: `GET /api/address/:a` existe pero **el nodo NO tiene `addressindex`** (devuelve `"limited data available"`, ceros) → no se puede escanear una dirección. `GET /api/transaction/:txid` **sí** funciona. Por tanto:
- El **wallet del pagador** firma+difunde (conoce el txid) y lo **reporta** al backend (`POST /payment_intents/:id/submit_tx` con `client_secret`).
- El backend **verifica** el txid vía `GET /api/transaction/:txid`: comprueba que una salida paga la **dirección derivada del intent** con importe ≥ esperado, y lee confirmaciones. Mempool/0-conf → `confirming`; ≥N-conf → `settled`. Poll por-tip (WS del Explorer, que solo emite altura) hasta confirmar.
- Sigue siendo **no-custodial** (el pagador firma y difunde; el backend solo lee la cadena).
- **Robustez futura (fix-upstream, no en F1A):** habilitar `addressindex` en el nodo del Explorer permitiría vigilancia por-dirección de respaldo (por si el wallet no reporta el txid).

> **Nota testnet:** `GET /api/stats?network=testnet` devuelve `blockHeight:0` → el **testnet de FairCoin está vacío/inactivo**. El test de liquidación **real** (T13 manual) requiere testnet operativo o mainnet con importe mínimo — a decidir. Los tests unitarios (T8–T12) usan mocks y no se bloquean.

### Entrada del payer (dos modos, mismo intent)

- **(A) Push (flujo héroe)** — el cobro apunta a un usuario Oxy conocido (el merchant pasa su Oxy id/handle) → push al monedero Peable → abre el intent → aprobar. FAIRWallet ya tiene push (`src/services/push-handler.ts`).
- **(B) QR / payment-link** — cobro abierto; cualquier usuario Peable escanea/abre → mismo `GET intent` → aprobar.

Ambos convergen en el mismo `PaymentIntent`. F1 implementa los dos; el flujo héroe verificado es (A). **El `PaymentIntent` se diseña agnóstico al canal de entrada** — un tercer canal, **NFC-TPV**, se añade en F3 sin tocar el core (ver "Roadmap: POS/NFC y SDK/Mercaria").

## Componentes por paquete

**`packages/frontend`** (fork + capa Oxy):
- `OxyProvider` montado en `app/_layout.tsx` (orden: `BloomThemeProvider` envuelve todo lo que use `useTheme`; sin hooks suspensivos boot-mounted). `clientId` vía `EXPO_PUBLIC_OXY_CLIENT_ID`.
- Cliente backend vía `oxyServices.createLinkedClient({ baseURL })` (re-mint device-first, sin `Authorization` manual).
- Pantalla **aprobar-pago**: importe (FairCoin + display fiat vía Explorer price, patrón Moovo), payee, dirección; botones aprobar/declinar. Aprobar → reutiliza el pipeline de firma/broadcast existente de FAIRWallet (`wallet-store`, `coin-selection`, `spv-client`).
- Bandeja de payment-requests + suscripción Socket.io para estado del intent en vivo.

**`packages/backend`** (de cero, layout canónico Oxy — Bun + Express + Mongoose + Socket.io):
- Modelos: `PaymentIntent`, `Merchant` (Oxy app id + xpub watch-only + índice de derivación + webhook url/secret + confirmaciones requeridas).
- Rutas: `POST /v1/payment-intents` (crear, auth merchant), `GET /v1/payment-intents/:id` (payer y merchant), `POST /v1/payment-intents/:id/reject`. Registro merchant vía app-keys de Console.
- Servicios: `derivation` (dirección por intent desde xpub), `settlement-watcher` (Explorer watch-only), `webhook-dispatcher` (firmado, reintentos).
- Auth: `@oxy.so/core/server` — merchant vía `serviceAuth`/app-key; payer vía `requireOxyAuth`. CORS `createOxyCors`, SSRF `safeFetch` en el fetch de webhooks.
- Socket.io: `io.use(oxy.authSocket())`, salas por `socket.user.id`, jamás client-supplied.

**`packages/shared-types`** (de cero): `PaymentIntent` DTO, enum de estados, `WebhookEvent` (`payment_intent.settled`, etc.), tipos de creación. Sin tipos de custodia.

## Manejo de errores

- **Expiry:** `PaymentIntent` con TTL (default p.ej. 15 min sin aprobar) → `expired`; watcher deja de observar.
- **Underpayment / importe erróneo:** tx a la dirección con importe < esperado → `failed` (no `settled`); webhook `payment_intent.failed`.
- **Reorg:** reutiliza la lógica reorg-rewind de FAIRWallet en el lado wallet; en backend, una confirmación revertida baja `settled`→`confirming` o `failed` según profundidad.
- **Webhook:** entrega firmada (HMAC con `webhook secret`), reintentos con backoff, `safeFetch` (anti-SSRF). Nunca bloquea la confirmación del intent.
- **Rechazo:** usuario declina → `rejected`; webhook `payment_intent.rejected`.

## Verificación (end-to-end, testnet)

1. `bun install` desde root (linker hoisted); tras churn nativo `rm -rf packages/*/node_modules && bun install` + `expo-doctor`.
2. Backend: `bun test` + `tsc --noEmit`. Levantar backend local.
3. Frontend: `bun run --filter @peable.to/frontend typecheck`; `expo start`. **Verificar en pestaña de navegador EN PRIMER PLANO** (reglas Bloom/Reanimated/expo-router: pestaña en background congela rAF y da falsos "blank"): cold boot de OxyProvider + theming Bloom + bandeja de requests.
4. **Prueba del flujo atómico (testnet):** merchant registra xpub testnet → `POST /payment-intents` → llega push/QR al monedero → aprobar → el wallet firma+difunde → el watcher pasa `confirming`→`settled` → webhook recibido (verificar firma). Confirmar que el backend **nunca** tuvo claves ni fondos (auditar que solo hay xpub + direcciones observadas).
5. Caso underpaid + caso expiry → estados `failed`/`expired` correctos.

## Decisiones (confirmadas por el usuario, 2026-07-18)

1. **Emparejado tx↔intent:** **xpub watch-only del merchant + dirección fresca por intent** (estilo BTCPay). No dirección estática.
2. **Fuente de watch-only:** **FairCoin Explorer** (HTTP + WebSocket, sin infra propia). `faircoind` RPC queda como alternativa futura.
3. **Confirmaciones para `settled`:** **1-conf** por defecto en testnet, **configurable por merchant**. `confirming` (0-conf mempool) es estado de primera clase.
4. **Merchant en el test:** **cuenta Peable con wallet** que aporta su xpub (dos self-custody + orquestador).
5. **Alineación Expo SDK:** fork viene en SDK 55 → **alinear a SDK 57 como sub-fase corta previa** dentro de F1.

## Roadmap: POS/NFC (F3) y SDK/Mercaria (F2)

> Investigado ahora para que F1 se construya de forma que estas capas encajen sin reescritura. No se construyen en F1.

**Principio (lo confirma la investigación): NFC y el SDK NO son un core de pago nuevo — son canales de entrada del MISMO `PaymentIntent`.** Si el intent es agnóstico al canal (push/QR/NFC/SDK) y conserva `confirming` (0-conf) de primera clase, F2 y F3 son capas encima.

**F2 — SDK `@peable.to/sdk` + apps (Mercaria) + plugins e-commerce:**
- Apps como **Mercaria** (`~/Mercaria`, marketplace) embeben el SDK (checkout / pay-button). El SDK llama al backend F1 (`POST /payment-intents`) con la **app-key emitida por Console** y renderiza el estado (pending→settled) vía Socket.io.
- Online/in-app: comprador (usuario Peable) recibe push o abre checkout → aprueba+firma → settle → webhook a Mercaria. Mercaria como merchant registra su **xpub watch-only** igual que en F1 (no-custodial).
- **Plugins para webs de terceros:** un **plugin de WordPress/WooCommerce** (y equivalentes Shopify/PrestaShop más adelante) para que cualquier tienda acepte Peable en su web — igual que el plugin WooCommerce de Stripe. El plugin es solo un cliente del Gateway (crea intents con la app-key de Console + verifica webhooks firmados); nada de custodia.

**F3 — POS físico / NFC "tipo Google Pay" (con FairCoin):**
- **Distinción crítica (legal + técnica):** "como Google Pay" = la **UX** (tocar el móvil), NO los **rieles**. No se toca EMV/Visa/Mastercard — eso exigiría emitir tarjeta + conversión fiat en el punto de venta = custodia/exchange = **CASP + licencia**. Peable es **circuito cerrado**: NFC solo transporta localmente el `PaymentIntent`/dirección entre TPV y móvil del pagador; la liquidación es on-chain FairCoin firmada por el wallet self-custody. **No-custodial, MiCA-safe.** Precedentes que validan el modelo: [Numo/Numopay](https://coincharge.io/en/numo-numopay-accept-bitcoin-tap-to-pay-via-nfc-in-stores/), [Flexa Tap-to-Pay](https://flexa.co/newsroom/tap-to-pay), Swiss Bitcoin Pay / Bolt Card.
- **Arquitectura NFC elegida (esquiva el muro de iOS):** el **TPV (Android, HCE) presenta** el intent por NFC; el móvil del pagador **lo lee** (modo lector). Así el pagador en **iPhone solo necesita Core NFC lectura** (desde iOS 11) — **sin** el entitlement HCE de Apple. Android TPV usa HCE ([`react-native-hce`](https://github.com/appidea/react-native-hce), Type 4 tag, EAS dev build; la carga NFC va **firmada por nosotros** — la lib transmite en claro). Pagador toca → su app abre el intent → aprueba+firma → settle.
- **Paridad total "tocar con la app cerrada"** (doble-clic botón lateral) en iPhone = requiere el **HCE entitlement de Apple** ([EEA, iOS 17.4+](https://developer.apple.com/support/hce-transactions-in-apps/); tras los compromisos DMA de jul-2024 **sin** necesidad de licencia PSP). Fase posterior; v1 POS = abrir-app-y-tocar, funciona en ambos SO sin entitlement.
- **El TPV es una app Expo APARTE** (`packages/terminal`, 2ª app Expo del monorepo, lado merchant) — **no** un modo del monedero. Usa el NFC del dispositivo: en **móvil** (Android nativo/HCE; iPhone según entitlement o dirección de lectura) y en **PC** vía el shell **Electron** que el fork ya trae + **lector USB NFC** (ACR122U) o WebNFC donde exista. Corre en un móvil, un Android POS estándar (Sunmi/PAX) o un PC con lector. Solo **crea `PaymentIntent`s (core F1)** y hace el hand-off NFC con el monedero del pagador. Móvil-a-móvil vale para empezar; terminal dedicado = productización.
- **Dirección del NFC (decisión F3):** convencional (TPV = lector, móvil pagador = HCE/tarjeta → iPhone necesita el HCE entitlement EEA) **o** invertida (TPV presenta, móvil pagador lee → iPhone solo Core NFC, sin entitlement). Al ser producto UE, el entitlement es viable; se decide en F3.
- **Latencia in-person (dato real de la red, Explorer):** FairCoin es **PoS**, bloques ~**30–100 s** (mempool vacío). El TPV **acepta en `confirming` (0-conf, tx en mempool)** para importe bajo (instantáneo, riesgo mínimo dado PoS + sin fee-market) y espera **1-conf (~1 min)** para importe alto. El estado `confirming` de F1 habilita esto — sin Lightning para low-value.
- **Verificar en F3:** finalidad/reorg de la PoS de FairCoin (profundidad segura para 0-conf) y si existen canales de pago para instant en importe alto.

**Implicación aplicable YA en F1:** `PaymentIntent` agnóstico al canal de entrada + `confirming` (0-conf) como estado de primera clase. Nada más de F2/F3 se construye ahora.

## Fuera de alcance explícito (no construir en F1)

SDK `@peable.to/sdk`, dashboard en Console, POS/tap-to-pay, suscripciones/recurrencia (per-approval o pre-firma nLockTime = fase R&D), on/off-ramp fiat (partner licenciado, no Oxy), refunds, payouts, antifraude, multi-currency.

## Nota legal

No es asesoría legal. La clasificación MiCA es funcional; antes de producción, opinión escrita de abogado cripto/fintech UE (CNMV en España) sobre: si la orquestación cruza a "transferencia por cuenta de clientes", estructura del partner de on-ramp, y AML/TFR por cuentas merchant.
