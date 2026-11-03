# Changelog

## 0.2.0 — checkout v2

- `checkout_sessions create` creates an ORDER (Orbit Phase 3): `--price <price_…>`
  (repeatable) or an inline `--amount [--currency] [--name]` line, `--quantity`,
  and a required `--success-url`. `--rail` / `--network` are gone: the line
  items' currency decides the rail.
- Requires `@peable.to/sdk` 0.18.0.

## 0.1.0 — first release

- `peable login` / `logout` / `whoami`: an Oxy application credential per
  profile and mode, verified against the gateway before it is stored, in a
  `0600` config file. The secret is never printed.
- `peable listen --forward-to <url> [--events …] [--print-json]`: test-mode
  events as they are recorded, signed with a per-session `whsec_…` and
  forwarded to a local server.
- `peable trigger <event>`: real test-mode objects that cause the event, with
  the test helpers finishing FairCoin payments.
- `peable logs tail`: the test-mode request log, live.
- `events list|retrieve`, `payment_intents list|retrieve|create`,
  `checkout_sessions create`, `webhook_endpoints list|create|delete`, `--json`.
- Requires `@peable.to/sdk` 0.15.0.
