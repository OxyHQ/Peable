<!-- Moved verbatim from AGENTS.md; the rules below are unchanged and binding. -->

# Non-custody is enforced in code, not by policy

**FairCoin is received into a Peable wallet, never into a key someone pasted
(ADR 0021 D5).** A merchant's FairCoin goes to the Peable wallet of the Oxy
account that OWNS its application — a person or an organization
(`merchants.owner_account_id`, mirrored from the verified credential's
`ownerAccountId` and the dashboard's application read by
`syncMerchantAuthority`) — and an on-behalf payment to the wallet of the
seller's own account (`connected_accounts.faircoin_oxy_user_id`).
`services/faircoin/recipient.ts` is the ONE place that decides who receives,
on which network (the merchant's environment's) and how the address is
reserved (`planFaircoinAddress`, then `addressPool.ts`'s
`reservePlannedAddresses` in the payment's transaction: the account's DID
`#key-1` PUBLIC key, `deriveSocialReceiveAddress`, a fresh index of the
one-statement cursor).
The payment stores the account it pays (`faircoin_recipient_account_id`).
No column holds a private or extended key — only the PUBLIC identity key
each address derives from — and there is no xpub registration: the private key
lives on the holder's devices only. Mainnet identity addresses are ADR 0002's deployment gate
(`PEABLE_SOCIAL_PAY_NETWORK`).

**A seller still CONFIRMS, in their own Oxy session.** `POST
/v1/connect/onboarding/:token/faircoin` (Oxy USER auth, the user the account
names) is the one writer of `faircoin_registered_at` (`confirmFaircoinHalf`)
and takes no body; it is refused 409 `faircoin_wallet_missing` while that
account has no identity key. Never add a service-authed path that confirms a
seller or names another receiving account: who receives the money is the
seller's consent, and a platform-supplied recipient is indistinguishable from
the platform's own.

**A recipient without a wallet is never refused an order and never silently
card-only.** FairCoin stays offered with `unavailable_reason:
'faircoin_wallet_missing'` (or `faircoin_network_closed`), confirming FairCoin
is a 409 with that code, and Orbit shows the owners a setup task (open Peable
as the owning account, or acting as the organization, and create its wallet).
