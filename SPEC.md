# purchase-receipts — SPEC v0.1

## Problem

An agent purchase API keeps the record of what a buyer saw and approved in the provider's database, readable only through the provider's API. Two things a later dispute needs are not in that record today.

Read from Sapiom's published OpenAPI spec (`docs.sapiom.ai/api-reference/openapi.json`) and from live sandbox transactions on 2026-11-10:

1. **What the buyer agreed to, once the checkout changes.** `purchase` holds only the latest revision, and there is no history endpoint. `authorizedAt` is set when the rules pass, which is not the same moment as the buyer confirming (see v0.1 below).
2. **Which spending limits applied.** Limits carry an integer `version` with optimistic concurrency (`409 RULE_VERSION_CONFLICT`). No field on the transaction references it, and `approvals` was an empty array in every sandbox read.

The record also carries no signature or hash, so a merchant, issuer or auditor must trust the provider's database as it is when they ask.

## What it does

A small TypeScript library and CLI, run on the buyer's or platform's side next to their integration:

1. **Capture.** At each change of a transaction (`version` changes), snapshot the transaction (`id`, `status`, `purchase`, `revision`, `nextAction`, `approvals`, `order`, `outcome`, `version`, `authorizedAt`, `completedAt`) and the spending limits of the card used (`version`, `purchaseLimit`, `recurringLimit`, `evaluatedAt`), when readable.
2. **Naive comparison.** Record `naiveLimitComparison`: whether `purchase.total.amount <= purchaseLimit.amount` (same currency) at capture time, and whether the limits `version` changed between approval and completion. It ignores `recurringLimit`, `customLimit`, `additionalLimits` and `usage`. It is a signal, not a replay of the provider's enforcement.
3. **Seal.** Build a receipt `{ schema, provider, capturedAt, transaction, limits, naiveLimitComparison, prev }`. `provider` names the adapter (`src/adapters/sapiom.ts`); the receipt format itself is provider-agnostic. `prev` is the SHA-256 (hex) of the previous line's compact JWS string, covering payload and signature, or `null` for the first. Sign the whole receipt as ES256 compact JWS.
4. **Verify, offline.** Every signature is valid, every `prev` link matches, `transaction.id` is constant. Then print the timeline and any findings.

## Interfaces

```
purchase-receipts keygen  --out <dir>
purchase-receipts capture --tx <id> --chain <chain.jsonl> --key <private.jwk>   # live; SAPIOM_API_KEY from env; card id from transaction.payment.paymentCardId; long-polls with since=<version>
purchase-receipts capture --from-json <tx.json> --limits <limits.json> ...      # offline / fixtures
purchase-receipts verify  <chain.jsonl> --key <public.jwk>
```

Chain file: JSONL, one compact JWS per line, oldest first.

## Who signs, and what that proves

- The capturing side's key signs. That proves the record has not been edited since capture and that no receipt in the middle was dropped, edited or reordered. It does **not** prove the provider or merchant said those things; it proves what the capturing system received from the provider's API, and when.
- Truncating the newest receipts is not detected without an outside anchor (for example a timestamp service).
- The stronger version is provider-side: the provider records, per revision, what the buyer confirmed and how, stamps the limits version, and signs the record. This repo shows the format and the checks working.

## v0.1: buyer step per revision

**What the sandbox showed** (transaction `01a1c4da-604a-739e-956b-a5a9b4dac15d`, 2026-11-10 09:46–09:51 UTC): the buyer confirmed revision 1 ($11.00) with their security code. After two `PUT /ucp/checkout` changes, the transaction read `status: authorized` with a new `authorizedAt` at revision 4 ($14.00) and revision 5 ($18.00). The buyer took no step at either revision. No payment was created at those totals because the store refused the item, so the test does not show whether a security code would have been asked before money moved. This is about the record, not the controls.

**Change:**
- `TransactionSnapshot` gains `revision` (`purchase.revision`, number or null) and `nextAction` (`nextAction.type`, string or null).
- New finding `authorized_without_buyer_step`: for each revision that reaches `authorized`, look for an earlier receipt at the same revision whose `nextAction` is `buyer_security_code`. If there is none, report the revision, its total and time, plus the last revision the buyer confirmed (a buyer step, then `authorized`, at that revision).
- Not applicable when `revision` is null.
- The wording is "captured": the chain only knows what it saw, so a capture gap can produce this finding. Long-polling every `version` change keeps that gap small.

## Done means (each check can fail)

| Check | Fails if |
|---|---|
| Round trip: capture → verify on fixtures | verify reports anything other than valid |
| Tamper: edit `purchase.total.amount` inside one receipt, re-encode | verify passes |
| Drop a middle receipt | verify passes |
| Reorder two receipts | verify passes |
| Wrong public key | verify passes |
| Limits v3 at approval, v4 at completion | not flagged |
| Over-limit purchase (120.00 vs 100.00) | not flagged |
| rev 1 buyer step → rev 1 authorized → rev 4 authorized ($14) | no finding, or detail omits "rev 1" / "11.00" |
| rev 1 buyer step → rev 1 authorized only (control) | any `authorized_without_buyer_step` finding |
| rev 1 buyer step → rev 2 authorized at the same total | no finding (revision, not total, is the key) |
| Sabotage: verify skips `prev` | drop/reorder tests still pass |
| Sabotage: amounts compared as strings ("9.00" > "10.00") | over-limit test still passes |
| Sabotage: buyer step matched at any revision | first v0.1 test still passes |
| Sabotage: key on total instead of revision | same-total test still passes |
| `tsc --noEmit` strict | any error |

## Fixtures

`fixtures/` is hand-built from the OpenAPI `example` values and field descriptions, and labeled as such. The live result in the README comes from real sandbox reads.

## Out of scope

Trusted timestamping (RFC 3161), provider-side signing, browser purchases (`order` is null for those), refund and dispute workflows, UI, publishing to npm.

## Dependencies

`jose` 6.2.3, exact pin. No JCS needed: `prev` hashes the compact JWS string.
