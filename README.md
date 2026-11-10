# purchase-receipts

Signed, hash-chained receipts for agent purchases, checkable offline by anyone holding the public key.

Agent purchase APIs keep the record of what a buyer saw and approved in the provider's database, readable only through the provider's API. Two things get lost:

- **What the buyer actually agreed to, once the checkout changes.** In the Sapiom sandbox (2026-11-10), a buyer confirmed $11.00 with their security code. After checkout updates, the same transaction read `authorized` at $14.00 and then $18.00, each with a new `authorizedAt`, though the buyer took no step at either total. The transaction keeps only the latest revision, so the final record says "authorized, $18.00". (No payment was created at those totals, because the store refused the item. The test did not reach the point where money would move.)
- **Which spending limits applied.** The transaction does not reference the version of the limits it was checked against.

`purchase-receipts` runs on the buyer's or platform's side. Each time a purchase changes, it captures the purchase (with its revision), the next step, the approvals, the order outcome and the card's spending limits (with their version). It signs the snapshot (ES256 compact JWS) and links it to the previous one by hash.

```
purchase-receipts keygen  --out keys/
purchase-receipts capture --tx <transactionId> --chain tx.jsonl --key keys/receipts.jwk.private.json   # Sapiom, SAPIOM_API_KEY in env
purchase-receipts verify  tx.jsonl --key keys/receipts.jwk.public.json
```

On the sandbox transaction above (`01a1c4da-604a-739e-956b-a5a9b4dac15d`, replayed from the saved API reads, so `capturedAt` is the replay time):

```
VALID chain
  …  waiting_approval rev 1  total 11.00 USD  no limits  next buyer_security_code
  …  authorized       rev 1  total 11.00 USD  no limits  next payment_ready
  …  authorized       rev 1  total 11.00 USD  no limits  next reconcile_checkout
  …  preparing        rev 2  total 11.00 USD  no limits  next wait
  …  waiting_approval rev 2  total 11.00 USD  no limits  next buyer_security_code
  …  authorized       rev 4  total 14.00 USD  no limits  next update_checkout
  …  authorized       rev 5  total 18.00 USD  no limits  next update_checkout
  …  cancelled        rev 5  total 18.00 USD  no limits  next closed
  finding: authorized_without_buyer_step: rev 4 (14.00 USD) authorized at 2026-11-10T09:49:50.124Z with no buyer step captured at rev 4; last revision the buyer confirmed (buyer step, then authorized): rev 1 (11.00 USD)
  finding: authorized_without_buyer_step: rev 5 (18.00 USD) authorized at 2026-11-10T09:50:58.136Z with no buyer step captured at rev 5; last revision the buyer confirmed (buyer step, then authorized): rev 1 (11.00 USD)
```

"no limits" because a dashboard-created sandbox platform key got `403 Missing required permissions: org.read` on `GET /v1/payment-cards/{id}/spending-limits`. Capture continues without them.

## What it proves, and what it does not

- Proves: the record has not been edited since capture; no receipt in the middle was dropped, edited or reordered; what each revision showed and whether a buyer step was captured at it; which limits version was in force at each step, when the limits are readable.
- Does not prove: that the provider or merchant said those things (the capturing side's key signs, not theirs); that the newest receipts were not cut off (needs an outside anchor); that a buyer step happened if capture missed it (`authorized_without_buyer_step` means "none captured"). `naiveLimitComparison` checks only the total against the single-purchase limit. It is not the provider's enforcement.
- The stronger version is provider-side. The provider records, per revision, what the buyer confirmed and how. It stamps the limits version on the transaction and signs the record. This repo shows the format and the checks working.

## Status

v0.1. Adapter: Sapiom (`src/adapters/sapiom.ts`), written against Sapiom's published OpenAPI spec and run against the Sapiom sandbox on 2026-11-10. `npm test` covers tamper, drop, reorder, wrong-key and rewritten-history checks, the buyer-step-per-revision check, and sabotage checks. A test fails if the verifier skips the hash link, compares amounts as text, accepts a buyer step from a different revision, or keys on total instead of revision. Fixtures in `fixtures/` are built from the spec's examples and labeled as such.
