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

// --- v0.1: buyer step per revision (shape taken from the live sandbox run, 2026-11-10 09:46-09:51 UTC) ---

function liveShapedTx(rev: number, status: string, next: string, total: string, authorizedAt: string | null = null) {
  return toTransactionSnapshot({
    id: "01a1c4da-604a-739e-956b-a5a9b4dac15d",
    status,
    version: `v-${rev}-${status}`,
    purchase: { type: "ucp_checkout", assertedBy: "merchant", total: { amount: total, currency: "USD" }, revision: rev },
    nextAction: { type: next },
    approvals: [],
    order: { outcome: "not_confirmed" },
    authorizedAt,
    payment: { paymentCardId: "01a1c450-7650-7bd9-8edb-59749eb4034b" },
  });
}

async function chainOf(priv: JWK, txs: ReturnType<typeof liveShapedTx>[]) {
  let chain: string[] = [];
  for (const [i, tx] of txs.entries()) {
    chain = await appendReceipt(chain, { provider: PROVIDER, capturedAt: `2026-11-10T09:${String(46 + i).padStart(2, "0")}:00Z`, transaction: tx, limits: null }, priv);
  }
  return chain;
}

const buyerStepFindings = (v: ChainVerification) => v.findings.filter((f) => f.kind === "authorized_without_buyer_step");

test("authorized at a new revision with no buyer step at that revision is reported", async () => {
  const { priv, pub } = await keys();
  const chain = await chainOf(priv, [
    liveShapedTx(1, "waiting_approval", "buyer_security_code", "11.00"),
    liveShapedTx(1, "authorized", "payment_ready", "11.00", "2026-11-10T09:47:49.461Z"),
    liveShapedTx(4, "authorized", "update_checkout", "14.00", "2026-11-10T09:49:50.124Z"),
  ]);
  const v = await verifyChain(chain, pub);
  assert.equal(v.valid, true);
  const f = buyerStepFindings(v);
  assert.equal(f.length, 1);
  assert.match(f[0]!.detail, /^rev 4 \(14\.00 USD\) authorized at 2026-11-10T09:49:50\.124Z/);
  assert.match(f[0]!.detail, /last revision the buyer confirmed \(buyer step, then authorized\): rev 1 \(11\.00 USD\)/);
});

test("control: buyer step then authorized at the same revision is not reported", async () => {
  const { priv, pub } = await keys();
  const chain = await chainOf(priv, [
    liveShapedTx(1, "waiting_approval", "buyer_security_code", "11.00"),
    liveShapedTx(1, "authorized", "payment_ready", "11.00", "2026-11-10T09:47:49.461Z"),
  ]);
  assert.deepEqual(buyerStepFindings(await verifyChain(chain, pub)), []);
});

test("a new revision at the SAME total still needs its own buyer step", async () => {
  const { priv, pub } = await keys();
  const chain = await chainOf(priv, [
    liveShapedTx(1, "waiting_approval", "buyer_security_code", "11.00"),
    liveShapedTx(1, "authorized", "payment_ready", "11.00"),
    liveShapedTx(2, "authorized", "payment_ready", "11.00"),
  ]);
  const f = buyerStepFindings(await verifyChain(chain, pub));
  assert.equal(f.length, 1);
  assert.match(f[0]!.detail, /^rev 2 \(11\.00 USD\)/);
});
