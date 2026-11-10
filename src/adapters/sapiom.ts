/**
 * Sapiom adapter: maps Sapiom API responses to provider-agnostic snapshots, and reads them live.
 *
 * Field names follow docs.sapiom.ai/api-reference/openapi.json as read on 2026-11-10:
 *   GET /v1/transactions/{transactionId}?since=<version>&maxWaitSeconds=<n>  -> TransactionResponseDto
 *   GET /v1/payment-cards/{cardId}/spending-limits                        -> limits with integer `version`
 * Auth: header `x-api-key` (a buyer key). Keys starting `sk_test_` reach the sandbox.
 */
import type { LimitsSnapshot, Money, TransactionSnapshot } from "../receipt.js";

export const PROVIDER = "sapiom";
const API_BASE = "https://api.sapiom.ai";
const LONG_POLL_SECONDS = 25;

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function money(v: unknown): Money | null {
  const o = obj(v);
  const amount = str(o?.amount);
  const currency = str(o?.currency);
  return amount && currency ? { amount, currency } : null;
}

export function toTransactionSnapshot(tx: unknown): TransactionSnapshot {
  const t = obj(tx);
  const id = str(t?.id);
  if (!t || !id) throw new Error("not a Sapiom transaction: missing id");
  const purchase = t.purchase ?? null;
  return {
    id,
    status: str(t.status) ?? "unknown",
    version: str(t.version),
    purchase,
    total: money(obj(purchase)?.total),
    approvals: t.approvals ?? null,
    order: t.order ?? null,
    outcome: str(t.outcome),
    authorizedAt: str(t.authorizedAt),
    completedAt: str(t.completedAt),
    paymentCardId: str(obj(t.payment)?.paymentCardId),
  };
}

export function toLimitsSnapshot(cardId: string, limits: unknown): LimitsSnapshot {
  const l = obj(limits);
  if (!l || typeof l.version !== "number") throw new Error("not a Sapiom spending-limits response: missing integer version");
  return {
    cardId,
    version: l.version,
    purchaseLimit: money(l.purchaseLimit),
    evaluatedAt: str(l.evaluatedAt),
    raw: limits,
  };
}

export class SapiomClient {
  /**
   * @param apiKey   buyer key: reads transactions.
   * @param limitsAuth platform key + buyer id (`sapiom-tenant` header): reads spending limits. Buyer keys
   *                 cannot read limits (403 "Missing required permissions: org.read", sandbox 2026-11-10).
   */
  constructor(
    private readonly apiKey: string,
    private readonly limitsAuth?: { platformKey: string; tenantId: string },
    private readonly base = API_BASE,
  ) {
    if (!apiKey) throw new Error("SAPIOM_API_KEY is empty");
  }

  private async get(path: string, headers: Record<string, string> = { "x-api-key": this.apiKey }): Promise<unknown> {
    const res = await fetch(this.base + path, { headers: { ...headers, accept: "application/json" } });
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text().catch(() => "")}`.slice(0, 500));
    return res.json();
  }

  /** Returns the transaction; with `since`, waits (server-side) until its version differs. */
  getTransaction(id: string, since?: string): Promise<unknown> {
    const q = since ? `?since=${encodeURIComponent(since)}&maxWaitSeconds=${LONG_POLL_SECONDS}` : "";
    return this.get(`/v1/transactions/${encodeURIComponent(id)}${q}`);
  }

  getSpendingLimits(cardId: string): Promise<unknown> {
    const headers: Record<string, string> = this.limitsAuth
      ? { "x-api-key": this.limitsAuth.platformKey, "sapiom-tenant": this.limitsAuth.tenantId }
      : { "x-api-key": this.apiKey };
    return this.get(`/v1/payment-cards/${encodeURIComponent(cardId)}/spending-limits`, headers);
  }
}
