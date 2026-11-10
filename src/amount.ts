/** USD-style decimal strings ("19.99", "100", "0.5") compared exactly, as integer cents. */
const AMOUNT_RE = /^(0|[1-9]\d{0,17})(\.\d{1,2})?$/;

export function toCents(amount: string): bigint {
  const m = AMOUNT_RE.exec(amount);
  if (!m) throw new Error(`invalid amount: ${JSON.stringify(amount)}`);
  const whole = BigInt(m[1]!);
  const frac = (m[2] ?? "").slice(1).padEnd(2, "0");
  return whole * 100n + BigInt(frac || "0");
}

export function amountWithinLimit(amount: string, limit: string): boolean {
  return toCents(amount) <= toCents(limit);
}
