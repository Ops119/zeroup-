import type { Hex, PublicClient } from "viem";
import { ZeroupPool } from "../generated/contracts";
import type { Deployment } from "../core/deployment";
import { decryptMemo, type Memo } from "../core/memo";

export interface AuditEntry {
  kind: Memo["kind"];
  block: string;
  tx: Hex;
  ts: number;
  /** For deposits: the public funding address. */
  depositor?: Hex;
  amount: string;
  fee?: string;
  payer?: Hex;
  payTo?: Hex;
  to?: Hex;
  resource?: string;
  /** Payment never settled; its funds came back to the pool (see the matching deposit). */
  reclaimed?: boolean;
}

export interface AuditReport {
  entries: AuditEntry[];
  totals: { deposited: string; paid: string; withdrawn: string; fees: string; shieldedBalance: string };
}

/**
 * Read-only history from a viewing key. The holder (accountant, auditor,
 * the user themself) sees every deposit, payment and exit and the current
 * shielded balance, but cannot spend: spending needs the separate spending key.
 */
export async function auditWithViewingKey(
  viewingKey: Uint8Array,
  client: PublicClient,
  d: Deployment,
  chunk = 5000n,
): Promise<AuditReport> {
  const latest = await client.getBlockNumber({ cacheTime: 0 });
  const entries: AuditEntry[] = [];
  const noteValues = new Map<number, bigint>();
  const spentNotes = new Set<number>();

  for (let from = BigInt(d.deployBlock); from <= latest; from += chunk) {
    const to = from + chunk - 1n < latest ? from + chunk - 1n : latest;
    const [deposits, withdrawals] = await Promise.all([
      client.getContractEvents({ address: d.pool, abi: ZeroupPool.abi, eventName: "Deposit", fromBlock: from, toBlock: to }),
      client.getContractEvents({ address: d.pool, abi: ZeroupPool.abi, eventName: "Withdrawal", fromBlock: from, toBlock: to }),
    ]);
    for (const e of deposits) {
      const memo = decryptMemo(viewingKey, e.args.encryptedNote!);
      if (memo?.kind !== "deposit") continue;
      noteValues.set(memo.noteIndex, BigInt(memo.value));
      entries.push({ kind: "deposit", block: e.blockNumber.toString(), tx: e.transactionHash, ts: memo.ts, depositor: e.args.depositor, amount: memo.value });
    }
    for (const e of withdrawals) {
      const memo = decryptMemo(viewingKey, e.args.encryptedNote!);
      if (!memo || memo.kind === "deposit") continue;
      noteValues.set(memo.noteIndex, BigInt(memo.value));
      spentNotes.add(memo.spentNoteIndex);
      const base = { block: e.blockNumber.toString(), tx: e.transactionHash, ts: memo.ts, fee: memo.fee };
      if (memo.kind === "payment") {
        entries.push({ kind: "payment", ...base, amount: memo.amount, payer: memo.payer, payTo: memo.payTo, resource: memo.resource });
      } else {
        entries.push({ kind: "withdraw", ...base, amount: memo.amount, to: memo.to });
      }
    }
  }

  // A deposit made *from* one of our one-time payers is a reclaim of an
  // unsettled payment, not new money or a completed payment.
  const payers = new Set(entries.filter((e) => e.kind === "payment").map((e) => e.payer?.toLowerCase()));
  const reclaimers = new Set(
    entries.filter((e) => e.kind === "deposit" && payers.has(e.depositor?.toLowerCase())).map((e) => e.depositor!.toLowerCase()),
  );
  for (const e of entries) {
    if (e.kind === "payment" && reclaimers.has(e.payer!.toLowerCase())) e.reclaimed = true;
    if (e.kind === "deposit" && reclaimers.has(e.depositor!.toLowerCase())) e.reclaimed = true;
  }

  const sum = (k: AuditEntry["kind"], f: (e: AuditEntry) => string | undefined) =>
    entries.filter((e) => e.kind === k && !e.reclaimed).reduce((s, e) => s + BigInt(f(e) ?? "0"), 0n);
  // A payment split across notes appears once per note; count its amount once.
  const payments = new Map<string, AuditEntry>();
  for (const e of entries) if (e.kind === "payment" && !e.reclaimed) payments.set(`${e.payer}`, e);
  const paid = [...payments.values()].reduce((s, e) => s + BigInt(e.amount), 0n);
  const fees = entries.filter((e) => e.kind !== "deposit").reduce((s, e) => s + BigInt(e.fee ?? "0"), 0n);
  const balance = [...noteValues.entries()].filter(([i]) => !spentNotes.has(i)).reduce((s, [, v]) => s + v, 0n);

  return {
    entries: entries.sort((a, b) => (BigInt(a.block) < BigInt(b.block) ? -1 : 1)),
    totals: {
      deposited: sum("deposit", (e) => e.amount).toString(),
      paid: paid.toString(),
      withdrawn: sum("withdraw", (e) => e.amount).toString(),
      fees: fees.toString(),
      shieldedBalance: balance.toString(),
    },
  };
}
