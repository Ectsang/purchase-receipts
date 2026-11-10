/**
 * Signed, hash-chained purchase receipts.
 *
 * One receipt per observed change of a purchase. Each receipt is an ES256 compact JWS over the
 * whole JSON payload (same format as `@goodmeta/agent-verifier` signReceipt), and carries `prev`:
 * the SHA-256 (hex) of the previous receipt's compact JWS string, or null for the first.
 * Editing, dropping or reordering a receipt in the middle breaks the chain.
 *
 * Not detected by the chain alone: truncation of the newest receipts (needs an outside anchor).
 */
import { createHash } from "node:crypto";
import { CompactSign, compactVerify, importJWK, type JWK } from "jose";
import { amountWithinLimit } from "./amount.js";

export const RECEIPT_SCHEMA = "purchase-receipt/v0";
const ALG = "ES256";

/** Statuses at which the buyer's approval is in play (Sapiom TransactionResponseDto.status). */
const APPROVAL_STATUSES = new Set(["waiting_approval", "authorized"]);
const FINAL_STATUSES = new Set(["completed", "denied", "cancelled"]);

export interface Money {
  amount: string;
  currency: string;
}

/** Provider-agnostic snapshot of the purchase as the buyer's system received it. */
export interface TransactionSnapshot {
  id: string;
  status: string;
  version: string | null;
  purchase: unknown;
  total: Money | null;
  approvals: unknown;
  order: unknown;
  outcome: string | null;
  authorizedAt: string | null;
  completedAt: string | null;
  paymentCardId: string | null;
}

export interface LimitsSnapshot {
  cardId: string;
  version: number;
  purchaseLimit: Money | null;
  evaluatedAt: string | null;
  /** Everything the provider returned, kept verbatim for the dispute file. */
  raw: unknown;
}

export interface Receipt {
  schema: typeof RECEIPT_SCHEMA;
  provider: string;
  capturedAt: string;
  transaction: TransactionSnapshot;
  limits: LimitsSnapshot | null;
  /**
   * A demo signal, NOT the provider's enforcement: compares only total vs the single-purchase
   * limit. Ignores recurring/custom/additional limits and usage.
   */
  naiveLimitComparison: { withinPurchaseLimit: boolean | null; reason: string };
  prev: string | null;
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function compareToLimit(total: Money | null, limits: LimitsSnapshot | null): Receipt["naiveLimitComparison"] {
  if (!total) return { withinPurchaseLimit: null, reason: "no purchase total" };
  if (!limits || !limits.purchaseLimit) return { withinPurchaseLimit: null, reason: "no purchase limit set" };
  if (total.currency !== limits.purchaseLimit.currency) {
    return { withinPurchaseLimit: null, reason: `currency mismatch ${total.currency} vs ${limits.purchaseLimit.currency}` };
  }
  const ok = amountWithinLimit(total.amount, limits.purchaseLimit.amount);
  return {
    withinPurchaseLimit: ok,
    reason: `${total.amount} ${ok ? "<=" : ">"} purchaseLimit ${limits.purchaseLimit.amount} (limits v${limits.version})`,
  };
}

export function buildReceipt(args: {
  provider: string;
  capturedAt: string;
  transaction: TransactionSnapshot;
  limits: LimitsSnapshot | null;
  prevJws: string | null;
}): Receipt {
  return {
    schema: RECEIPT_SCHEMA,
    provider: args.provider,
    capturedAt: args.capturedAt,
    transaction: args.transaction,
    limits: args.limits,
    naiveLimitComparison: compareToLimit(args.transaction.total, args.limits),
    prev: args.prevJws === null ? null : sha256Hex(args.prevJws),
  };
}

export async function signReceipt(receipt: Receipt, privateKey: JWK): Promise<string> {
  const key = await importJWK(privateKey, ALG);
  return new CompactSign(new TextEncoder().encode(JSON.stringify(receipt))).setProtectedHeader({ alg: ALG }).sign(key);
}

/** Append one receipt to a chain (array of compact JWS strings, oldest first). */
export async function appendReceipt(
  chain: readonly string[],
  args: Omit<Parameters<typeof buildReceipt>[0], "prevJws">,
  privateKey: JWK,
): Promise<string[]> {
  const prevJws = chain.length ? chain[chain.length - 1]! : null;
  const jws = await signReceipt(buildReceipt({ ...args, prevJws }), privateKey);
  return [...chain, jws];
}

export interface ChainFinding {
  kind: "limits_changed_after_approval" | "over_purchase_limit" | "order_outcome_unknown";
  detail: string;
}

export interface ChainVerification {
  valid: boolean;
  errors: string[];
  receipts: Receipt[];
  findings: ChainFinding[];
}

export async function verifyChain(chain: readonly string[], publicKey: JWK): Promise<ChainVerification> {
  const errors: string[] = [];
  const receipts: Receipt[] = [];
  if (chain.length === 0) return { valid: false, errors: ["empty chain"], receipts, findings: [] };

  let key;
  try {
    key = await importJWK(publicKey, ALG);
  } catch (e) {
    return { valid: false, errors: [`bad public key: ${(e as Error).message}`], receipts, findings: [] };
  }

  for (let i = 0; i < chain.length; i++) {
    const jws = chain[i]!;
    let r: Receipt;
    try {
      const { payload } = await compactVerify(jws, key, { algorithms: [ALG] });
      r = JSON.parse(new TextDecoder().decode(payload)) as Receipt;
    } catch (e) {
      errors.push(`receipt ${i}: signature invalid (${(e as Error).message})`);
      continue;
    }
    if (r.schema !== RECEIPT_SCHEMA) errors.push(`receipt ${i}: unknown schema ${String(r.schema)}`);
    const expectedPrev = i === 0 ? null : sha256Hex(chain[i - 1]!);
    if (r.prev !== expectedPrev) errors.push(`receipt ${i}: prev does not match receipt ${i - 1} (dropped, reordered or edited)`);
    if (receipts[0] && r.transaction.id !== receipts[0].transaction.id) {
      errors.push(`receipt ${i}: transaction id ${r.transaction.id} differs from ${receipts[0].transaction.id}`);
    }
    if (receipts[0] && r.provider !== receipts[0].provider) errors.push(`receipt ${i}: provider changed`);
    const last = receipts[receipts.length - 1];
    if (last && r.capturedAt < last.capturedAt) errors.push(`receipt ${i}: capturedAt goes backwards`);
    receipts.push(r);
  }

  return { valid: errors.length === 0, errors, receipts, findings: findingsFor(receipts) };
}

function findingsFor(receipts: Receipt[]): ChainFinding[] {
  const out: ChainFinding[] = [];
  const atApproval = receipts.find((r) => APPROVAL_STATUSES.has(r.transaction.status) && r.limits);
  const atFinal = [...receipts].reverse().find((r) => FINAL_STATUSES.has(r.transaction.status) && r.limits);
  if (atApproval?.limits && atFinal?.limits && atApproval.limits.version !== atFinal.limits.version) {
    out.push({
      kind: "limits_changed_after_approval",
      detail: `limits v${atApproval.limits.version} at ${atApproval.transaction.status} (${atApproval.capturedAt}), v${atFinal.limits.version} at ${atFinal.transaction.status} (${atFinal.capturedAt})`,
    });
  }
  for (const r of receipts) {
    if (r.naiveLimitComparison.withinPurchaseLimit === false) {
      out.push({ kind: "over_purchase_limit", detail: `${r.transaction.status} at ${r.capturedAt}: ${r.naiveLimitComparison.reason}` });
      break;
    }
  }
  const lastOrder = receipts[receipts.length - 1]?.transaction.order as { outcome?: unknown } | null | undefined;
  if (lastOrder && lastOrder.outcome === "unknown") {
    out.push({ kind: "order_outcome_unknown", detail: "latest receipt records the merchant order outcome as unknown" });
  }
  return out;
}
