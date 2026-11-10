# purchase-receipts — SPEC v0 (2026-11-10)

## Problem (from Sapiom's own words)

Sapiom's payments job post (Ashby, "Member of Technical Staff (Payments)", published 2026-10-26) asks for:

> "A versioned record of what a buyer saw and agreed to, still legible months later when someone disputes it."

and says limit enforcement is still being designed:

> "how that gets enforced before money moves rather than explained afterwards. Most of these decisions are still open."

What the public API gives today (read from `docs.sapiom.ai/api-reference/openapi.json`, 2026-11-10):

- `GET /v1/transactions/{id}` → `TransactionResponseDto`: `purchase` (what, from whom, how much, `assertedBy`), `approvals` (opaque object), `order` (`confirmed | not_confirmed | unknown`), `status`, `version` (a change token, "changes whenever anything the caller acts on changes"), timestamps.
- `GET /v1/payment-cards/{cardId}/spending-limits` → limits with an integer `version` ("Current saved version"), `purchaseLimit`, `recurringLimit`, `evaluatedAt`, `usage`.
- The words "signature" and "hash" appear nowhere in the spec. The record is readable only through Sapiom's API with the buyer's key.

**Two gaps this tool addresses (improvements to propose to Sapiom):**

1. **The published transaction schema does not say which version of the spending limits it was checked against.** Limits carry an integer `version` with optimistic concurrency (`409 RULE_VERSION_CONFLICT`, docs.sapiom.ai/controls/spending-limits.md); no typed field on `TransactionResponseDto` references it. Caveat: `approvals` is an untyped `object` ("inspect an approval for current authority") and no docs page describes its contents, so limit data could live there — unconfirmed until sandbox.
2. **The record cannot be checked without Sapiom.** No signature, no hash, no export format. A merchant, issuer or auditor in a dispute must trust Sapiom's database as it is at that later moment.

## What it does (v0)

A small TypeScript library + CLI, run by a **Sapiom customer** (the buyer/platform) next to their Sapiom integration:

1. **Capture.** At each change of a transaction (`version` changes), take a snapshot of: the transaction (`id`, `status`, `purchase`, `approvals`, `order`, `outcome`, `version`, `authorizedAt`, `completedAt`) and the spending limits of the card used (`version`, `purchaseLimit`, `recurringLimit`, `evaluatedAt`).
2. **Naive comparison (not Sapiom's rule).** Record `naiveLimitComparison`: whether `purchase.total.amount <= purchaseLimit.amount` (same currency) at capture time, and whether the limits `version` changed between the snapshot taken at `waiting_approval`/`authorized` and the one at `completed`.
3. **Seal.** Build a receipt: `{ schema, provider, capturedAt, transaction, limits, naiveLimitComparison, prev }` where `provider` = `"sapiom"` (provider-specific capture lives in `src/adapters/sapiom.ts`; the receipt format is provider-agnostic — Locus has the same two gaps) and `prev` = SHA-256 (hex) of the **previous line's compact JWS string** (covers payload and signature), or `null` for the first (hash chain → each new version links to the last; an edited, dropped or reordered middle receipt breaks the chain; truncating the newest receipts is NOT detected without an outside anchor). Sign the whole receipt as ES256 compact JWS — the same format as `@goodmeta/agent-verifier` `signReceipt`, implemented directly on `jose` (agent-verifier 0.8.0 pins `zod` 4.4.3, which `npm audit` flags high: GHSA-mrhx-c7xc-m3w5).
4. **Verify (offline).** `verify <chain-file> --key <public.jwk>`: every signature valid, every `prev` link matches, `transaction.id` constant, then print the timeline: what the buyer saw at approval, the limit version in force, what completed.

## Interfaces

```
purchase-receipts capture --tx <id>      # live: SAPIOM_API_KEY from env; card id read from transaction.payment.paymentCardId; long-poll with since=<version>
purchase-receipts capture --from-json <tx.json> --limits <limits.json>   # offline / fixtures
purchase-receipts verify <chain.jsonl> --key <public.jwk>
```

Chain file = JSONL, one compact JWS per line, oldest first.

## Who signs, and what that proves (honest scope)

- v0: **the buyer's own key** signs. That proves the buyer's record has not been edited since capture and links each version to the one before it. It does **not** prove Sapiom or the merchant said those things; it proves what the buyer's system received from Sapiom's API, when.
- The stronger version — **Sapiom signs the record and stamps the limit version on the transaction** — is the improvement we propose to them. This tool shows the format and the verification working, so the proposal is concrete.

## Done means (each can fail)

| Check | Fails if |
|---|---|
| Round trip: capture → verify on fixtures | verify reports anything other than valid |
| Tamper: edit `purchase.total.amount` inside one receipt payload, re-encode | verify passes |
| Drop a middle receipt from the chain | verify passes |
| Reorder two receipts | verify passes |
| Wrong public key | verify passes |
| Limit changed between approval and completion (fixture: limits v3 at approval, v4 at completion) | check does not flag it |
| Over-limit purchase (total 120.00 vs limit 100.00) | check does not flag it |
| Sabotage: a verify that skips `prev` checking | the drop/reorder tests still pass (must not) |
| Sabotage: a check that compares strings ("9.00" > "10.00") | over-limit test still passes (must not) |
| `tsc --noEmit` strict | any error |

## Fixtures

Built from the OpenAPI `example` values and field descriptions. **Labeled as fixtures**, not real Sapiom responses — Eric has no sandbox access yet (sandbox is "only enabled per organization", docs.sapiom.ai/sandbox.md). Re-run against sandbox once enabled.

## Out of scope (v0)

Trusted timestamping (RFC 3161), Sapiom-side signing, browser purchases (`order` is null for those), refunds/disputes workflow, UI, publishing to npm.

## Dependencies

`jose` 6.2.3 (exact pin). No JCS needed: `prev` hashes the compact JWS string.

## Changes after review (2026-11-10 ~06:50 UTC)
- `prev` pinned to SHA-256 of the previous compact JWS line.
- `--card` dropped: read from `transaction.payment.paymentCardId`.
- `provider` field + `src/adapters/sapiom.ts` to keep the format provider-agnostic.
- The check is named `naiveLimitComparison`: it ignores `recurringLimit`, `customLimit`, `additionalLimits`, `usage`. It is a demo signal, not a replay of Sapiom's enforcement.
- Gap 1 reworded as a published-schema claim with the `approvals` caveat.

## v0.1 — buyer step per revision (2026-11-10 ~09:55 UTC, after the live revision test)

**What the sandbox showed** (tx `01a1c4da-604a-739e-956b-a5a9b4dac15d`, 09:46–09:51 UTC): the buyer confirmed revision 1 ($11.00) with their security code. After checkout changes, the transaction read `status: authorized` with a new `authorizedAt` at revision 4 ($14.00) and revision 5 ($18.00). The buyer took no step at either revision. No payment existed at those totals because the store refused the item, so nothing shows whether a security code would have been asked before money moved. `purchase` holds only the latest revision; there is no history endpoint. So `authorizedAt` is when the rules passed, not when the buyer agreed, and the record does not keep what the buyer agreed to once the checkout changes.

**Change:**
- `TransactionSnapshot` gains `revision` (`purchase.revision`, number or null) and `nextAction` (`nextAction.type`, string or null).
- New finding `authorized_without_buyer_step`: for each revision that reaches `authorized` in the chain, look for an earlier receipt **at the same revision** whose `nextAction` is `buyer_security_code`. If there is none, report the revision, its total and the time, plus the last revision the buyer confirmed: a buyer step, then `authorized`, at that revision (and its total).
- Not applicable (no finding) when `revision` is null, e.g. chains captured before v0.1.
- Wording is "captured": the chain only knows what it saw. A capture gap can produce this finding. Live capture long-polls every `version` change, which is what makes the gap small.

**Done means (each can fail):**

| Check | Fails if |
|---|---|
| rev 1 buyer step → rev 1 authorized → rev 4 authorized ($14) | no finding, or detail omits "rev 1" / "11.00" |
| rev 1 buyer step → rev 1 authorized only (control) | any `authorized_without_buyer_step` finding |
| rev 1 buyer step → rev 2 authorized at the **same** total | no finding (revision, not total, is the key) |
| Sabotage: match a buyer step at any revision | first test still passes (must not) |
| Sabotage: key on total instead of revision | same-total test still passes (must not) |
