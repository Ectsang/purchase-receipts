import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { exportJWK, generateKeyPair, type JWK } from "jose";
import { PROVIDER, toLimitsSnapshot, toTransactionSnapshot } from "../src/adapters/sapiom.js";
import { appendReceipt, sha256Hex, verifyChain, type ChainVerification, type LimitsSnapshot, type Receipt } from "../src/receipt.js";
import { amountWithinLimit } from "../src/amount.js";

const FIX = new URL("../fixtures/", import.meta.url);
const json = async (name: string) => JSON.parse(await readFile(new URL(name, FIX), "utf8"));

async function keys() {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  return { priv: (await exportJWK(privateKey)) as JWK, pub: (await exportJWK(publicKey)) as JWK };
}

/** Build a 3-receipt chain: waiting_approval -> authorized -> completed. */
async function buildChain(priv: JWK, opts: { limitsAtEnd?: string } = {}) {
  const txFiles = ["tx-1-waiting-approval.json", "tx-2-authorized.json", "tx-3-completed.json"];
  const limitFiles = ["limits-v3.json", "limits-v3.json", opts.limitsAtEnd ?? "limits-v3.json"];
  let chain: string[] = [];
  for (let i = 0; i < txFiles.length; i++) {
    const tx = toTransactionSnapshot(await json(txFiles[i]!));
    const limits: LimitsSnapshot = toLimitsSnapshot(tx.paymentCardId!, await json(limitFiles[i]!));
    chain = await appendReceipt(chain, { provider: PROVIDER, capturedAt: `2026-11-10T07:0${i}:30Z`, transaction: tx, limits }, priv);
  }
  return chain;
}

/** Re-sign a receipt after editing its payload, keeping the chain link as it was (attacker has the key). */
async function editAndResign(jws: string, priv: JWK, edit: (r: Receipt) => void) {
  const { CompactSign, importJWK } = await import("jose");
  const r = JSON.parse(Buffer.from(jws.split(".")[1]!, "base64url").toString("utf8")) as Receipt;
  edit(r);
  return new CompactSign(new TextEncoder().encode(JSON.stringify(r))).setProtectedHeader({ alg: "ES256" }).sign(await importJWK(priv, "ES256"));
}

/** Edit the payload WITHOUT re-signing (attacker without the key). */
function editWithoutKey(jws: string, edit: (r: Receipt) => void) {
  const [h, p, s] = jws.split(".");
  const r = JSON.parse(Buffer.from(p!, "base64url").toString("utf8")) as Receipt;
  edit(r);
  return [h, Buffer.from(JSON.stringify(r)).toString("base64url"), s].join(".");
}

type Verify = (chain: readonly string[], pub: JWK) => Promise<ChainVerification>;

/** The chain-integrity checks. Each returns true when the verifier behaved correctly. */
async function integrityChecks(verify: Verify): Promise<Record<string, boolean>> {
  const { priv, pub } = await keys();
  const other = await keys();
  const chain = await buildChain(priv);
  return {
    roundTrip: (await verify(chain, pub)).valid === true,
    tamperedAmount: (await verify([chain[0]!, editWithoutKey(chain[1]!, (r) => { r.transaction.total = { amount: "1.00", currency: "USD" }; }), chain[2]!], pub)).valid === false,
    droppedMiddle: (await verify([chain[0]!, chain[2]!], pub)).valid === false,
    reordered: (await verify([chain[0]!, chain[2]!, chain[1]!], pub)).valid === false,
    // Key holder rewrites history in the middle: the next receipt's prev no longer matches.
    rewrittenMiddleWithKey: (await verify([chain[0]!, await editAndResign(chain[1]!, priv, (r) => { r.transaction.status = "denied"; }), chain[2]!], pub)).valid === false,
    wrongKey: (await verify(chain, other.pub)).valid === false,
  };
}

test("chain integrity: every check passes with the real verifier", async () => {
  const results = await integrityChecks(verifyChain);
  for (const [name, ok] of Object.entries(results)) assert.equal(ok, true, name);
});

test("sabotage: a verifier that skips prev checking is caught", async () => {
  const skipsPrev: Verify = async (chain, pub) => {
    const r = await verifyChain(chain, pub);
    const errors = r.errors.filter((e) => !e.includes("prev does not match"));
    return { ...r, errors, valid: errors.length === 0 };
  };
  const results = await integrityChecks(skipsPrev);
  assert.equal(results.droppedMiddle, false, "drop must go undetected by the broken verifier, so the real test is what catches it");
  assert.equal(results.reordered === false || results.rewrittenMiddleWithKey === false, true);
});

test("first receipt links to nothing; later receipts link to the previous JWS string", async () => {
  const { priv } = await keys();
  const chain = await buildChain(priv);
  const payloads = chain.map((j) => JSON.parse(Buffer.from(j.split(".")[1]!, "base64url").toString("utf8")) as Receipt);
  assert.equal(payloads[0]!.prev, null);
  assert.equal(payloads[1]!.prev, sha256Hex(chain[0]!));
  assert.equal(payloads[2]!.prev, sha256Hex(chain[1]!));
});

test("finding: limits lowered between approval and completion", async () => {
  const { priv, pub } = await keys();
  const changed = await verifyChain(await buildChain(priv, { limitsAtEnd: "limits-v4-lowered.json" }), pub);
  assert.equal(changed.valid, true);
  assert.ok(changed.findings.some((f) => f.kind === "limits_changed_after_approval"), JSON.stringify(changed.findings));
  assert.ok(changed.findings.some((f) => f.kind === "over_purchase_limit"), "19.99 > lowered limit 10.00");

  const same = await verifyChain(await buildChain(priv), pub);
  assert.equal(same.findings.some((f) => f.kind === "limits_changed_after_approval"), false);
  assert.equal(same.findings.some((f) => f.kind === "over_purchase_limit"), false);
});

const AMOUNT_CASES: Array<[string, string, boolean]> = [
  ["120.00", "100.00", false],
  ["100.00", "100.00", true],
  ["9.00", "10.00", true],
  ["10", "9.99", false],
  ["0.5", "0.49", false],
  ["19.99", "20", true],
];

test("amount comparison is numeric, not textual", () => {
  for (const [a, l, want] of AMOUNT_CASES) assert.equal(amountWithinLimit(a, l), want, `${a} vs ${l}`);
  assert.throws(() => amountWithinLimit("1e3", "100"));
  assert.throws(() => amountWithinLimit("-1", "100"));
});

test("sabotage: a string comparison fails the amount cases", () => {
  const stringCompare = (a: string, l: string) => a <= l;
  assert.ok(AMOUNT_CASES.some(([a, l, want]) => stringCompare(a, l) !== want));
});

test("adapter reads the card id from the transaction's payment", async () => {
  const tx = toTransactionSnapshot(await json("tx-2-authorized.json"));
  assert.equal(tx.paymentCardId, "card_fixture_1");
  assert.deepEqual(tx.total, { amount: "19.99", currency: "USD" });
  assert.throws(() => toLimitsSnapshot("c", { purchaseLimit: null }), /integer version/);
});
