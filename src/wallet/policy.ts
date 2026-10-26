import type { PaymentRecord } from "./store";

/** Agent spending guardrails, checked before any money leaves the pool. */
export interface SpendPolicy {
  /** Largest single payment, atomic units. */
  maxPerPayment: bigint;
  /** Rolling 24h budget, atomic units (fees included). */
  dailyBudget: bigint;
  /** If set, only these hosts may be paid. */
  allowedHosts?: string[];
  /** Never pay these recipients. */
  blockedPayTo?: string[];
}

export const DEFAULT_POLICY: SpendPolicy = {
  maxPerPayment: 1_000_000n, // 1 USDC
  dailyBudget: 20_000_000n, // 20 USDC
};

export class PolicyError extends Error {}

export function checkPolicy(
  policy: SpendPolicy,
  req: { amount: bigint; fee: bigint; payTo: string; url: string },
  history: PaymentRecord[],
  now = Date.now(),
): void {
  if (req.amount > policy.maxPerPayment) {
    throw new PolicyError(`amount ${req.amount} exceeds per-payment limit ${policy.maxPerPayment}`);
  }
  const host = safeHost(req.url);
  if (policy.allowedHosts && !policy.allowedHosts.includes(host)) {
    throw new PolicyError(`host ${host} is not on the allowlist`);
  }
  if (policy.blockedPayTo?.some((a) => a.toLowerCase() === req.payTo.toLowerCase())) {
    throw new PolicyError(`recipient ${req.payTo} is blocked by policy`);
  }
  const spent = history
    .filter((p) => p.status !== "failed" && now - p.ts < 86_400_000)
    .reduce((s, p) => s + BigInt(p.amount) + BigInt(p.fee), 0n);
  if (spent + req.amount + req.fee > policy.dailyBudget) {
    throw new PolicyError(`daily budget ${policy.dailyBudget} would be exceeded (spent ${spent})`);
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
