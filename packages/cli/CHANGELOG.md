# Changelog

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
