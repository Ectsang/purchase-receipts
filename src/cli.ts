#!/usr/bin/env -S npx tsx
/**
 * purchase-receipts keygen  --out <dir>
 * purchase-receipts capture --tx <id> --chain <file.jsonl> --key <private.jwk.json>      (live, SAPIOM_API_KEY from env)
 * purchase-receipts capture --from-json <tx.json> [--limits <limits.json>] --chain <file.jsonl> --key <private.jwk.json>
 * purchase-receipts verify  <file.jsonl> --key <public.jwk.json>
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exportJWK, generateKeyPair, type JWK } from "jose";
import { PROVIDER, SapiomClient, toLimitsSnapshot, toTransactionSnapshot } from "./adapters/sapiom.js";
import { appendReceipt, verifyChain, type LimitsSnapshot } from "./receipt.js";

const FINAL = new Set(["completed", "denied", "cancelled"]);

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function need(args: string[], name: string): string {
  const v = flag(args, name);
  if (!v) throw new Error(`missing ${name}`);
  return v;
}
async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}
async function readChain(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8")).split("\n").map((l) => l.trim()).filter(Boolean);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

async function keygen(args: string[]) {
  const dir = need(args, "--out");
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "receipts.jwk.private.json"), JSON.stringify(await exportJWK(privateKey)), { mode: 0o600 });
  await writeFile(join(dir, "receipts.jwk.public.json"), JSON.stringify(await exportJWK(publicKey)));
  console.log(`wrote ${join(dir, "receipts.jwk.public.json")} (and the private key next to it, mode 600)`);
}

async function capture(args: string[]) {
  const chainPath = need(args, "--chain");
  const privateKey = (await readJson(need(args, "--key"))) as JWK;
  let chain = await readChain(chainPath);

  const fromJson = flag(args, "--from-json");
  if (fromJson) {
    const tx = toTransactionSnapshot(await readJson(fromJson));
    const limitsPath = flag(args, "--limits");
    const limits = limitsPath && tx.paymentCardId ? toLimitsSnapshot(tx.paymentCardId, await readJson(limitsPath)) : null;
    chain = await appendReceipt(chain, { provider: PROVIDER, capturedAt: new Date().toISOString(), transaction: tx, limits }, privateKey);
    await appendFile(chainPath, chain[chain.length - 1] + "\n");
    console.log(`appended receipt ${chain.length - 1}: ${tx.id} ${tx.status}`);
    return;
  }

  const client = new SapiomClient(process.env.SAPIOM_API_KEY ?? "");
  const id = need(args, "--tx");
  let since: string | undefined;
  for (;;) {
    const tx = toTransactionSnapshot(await client.getTransaction(id, since));
    if (since !== undefined && tx.version === since) continue; // long-poll timed out with no change
    let limits: LimitsSnapshot | null = null;
    if (tx.paymentCardId) limits = toLimitsSnapshot(tx.paymentCardId, await client.getSpendingLimits(tx.paymentCardId));
    chain = await appendReceipt(chain, { provider: PROVIDER, capturedAt: new Date().toISOString(), transaction: tx, limits }, privateKey);
    await appendFile(chainPath, chain[chain.length - 1] + "\n");
    console.log(`receipt ${chain.length - 1}: ${tx.status} (tx version ${tx.version}, limits v${limits?.version ?? "-"})`);
    if (FINAL.has(tx.status)) return;
    since = tx.version ?? undefined;
  }
}

async function verify(args: string[]) {
  const file = args[0];
  if (!file) throw new Error("usage: verify <file.jsonl> --key <public.jwk.json>");
  const result = await verifyChain(await readChain(file), (await readJson(need(args, "--key"))) as JWK);
  console.log(result.valid ? "VALID chain" : "INVALID chain");
  for (const e of result.errors) console.log(`  error: ${e}`);
  for (const r of result.receipts) {
    const lim = r.limits ? `limits v${r.limits.version}` : "no limits";
    const total = r.transaction.total ? `${r.transaction.total.amount} ${r.transaction.total.currency}` : "-";
    console.log(`  ${r.capturedAt}  ${r.transaction.status.padEnd(16)} total ${total}  ${lim}`);
  }
  for (const f of result.findings) console.log(`  finding: ${f.kind}: ${f.detail}`);
  process.exitCode = result.valid ? 0 : 1;
}

const [cmd, ...rest] = process.argv.slice(2);
const commands: Record<string, (a: string[]) => Promise<void>> = { keygen, capture, verify };
const run = cmd ? commands[cmd] : undefined;
if (!run) {
  console.error("usage: purchase-receipts <keygen|capture|verify> ...");
  process.exitCode = 2;
} else {
  run(rest).catch((e: unknown) => {
    console.error((e as Error).message);
    process.exitCode = 1;
  });
}
