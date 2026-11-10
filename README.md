# purchase-receipts

Signed, hash-chained receipts for agent purchases, checkable offline by anyone holding the public key.

Built for one gap in agent purchase APIs today: the record of what a buyer saw and approved lives only in the provider's database, readable through the provider's API, and does not say which version of the spending limits it was checked against. In a dispute months later, the merchant, the issuer or an auditor has to trust that database as it is then.

`purchase-receipts` runs on the buyer's side. Each time a purchase changes, it captures the purchase, the approvals, the order outcome and the card's spending limits (with their version), signs the snapshot (ES256 compact JWS) and links it to the previous one by hash.

```
purchase-receipts keygen  --out keys/
purchase-receipts capture --tx <transactionId> --chain tx.jsonl --key keys/receipts.jwk.private.json   # Sapiom, SAPIOM_API_KEY in env
purchase-receipts verify  tx.jsonl --key keys/receipts.jwk.public.json
```

```
VALID chain
  2026-11-10T06:48:55.389Z  waiting_approval total 19.99 USD  limits v3
  2026-11-10T06:48:55.654Z  authorized       total 19.99 USD  limits v3
  2026-11-10T06:48:55.997Z  completed        total 19.99 USD  limits v4
  finding: limits_changed_after_approval: limits v3 at waiting_approval (…), v4 at completed (…)
```

## What it proves, and what it does not

- Proves: the buyer's record has not been edited since capture; no receipt in the middle was dropped, edited or reordered; which limits version was in force at each step, as the provider's API reported it.
- Does not prove: that the provider or merchant said those things (the buyer's key signs, not theirs); that the newest receipts were not cut off (needs an outside anchor). `naiveLimitComparison` checks only the total against the single-purchase limit; it is not the provider's enforcement.
- The stronger version is provider-side: the provider stamps the limits version on the transaction and signs the record. This repo shows the format working.

## Status

v0. Adapter: Sapiom (`src/adapters/sapiom.ts`), written against Sapiom's published OpenAPI spec. **Tested on fixtures built from that spec's examples (`fixtures/`), not yet against a live sandbox.** `npm test` includes tamper, drop, reorder, wrong-key and rewritten-history checks, plus sabotage checks that a verifier skipping the hash link, or comparing amounts as text, gets caught.
