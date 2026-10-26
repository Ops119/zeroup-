import express, { type Request, type Response } from "express";
import { getAddress, parseEventLogs, type Hex, type PublicClient } from "viem";
import { ZeroupPool, Screener } from "../generated/contracts";
import type { Deployment } from "../core/deployment";
import { SerialQueue, type Wallet } from "../core/chain";
import { publicSignals, verifyWithdrawProof, type SolidityProof } from "../core/prover";
import { caip2 } from "../core/x402";
import { splitSignature } from "../core/eip3009";
import { RateLimiter, errorMessage, httpError, statusFor } from "./http";

export interface SponsorOptions {
  deployment: Deployment;
  publicClient: PublicClient;
  wallet: Wallet;
  /** Fee taken from each withdrawal to cover gas, atomic token units. */
  withdrawFee: bigint;
  /** Gasless deposits allowed per funding address per hour. */
  depositsPerHour?: number;
  /** Smallest gasless deposit, so dust deposits cannot drain the sponsor's gas. */
  minDeposit?: bigint;
  log?: (msg: string) => void;
}

const big = (v: unknown, name: string): bigint => {
  try {
    if (typeof v !== "string" && typeof v !== "number") throw new Error();
    const n = BigInt(v);
    if (n < 0n || n >= 2n ** 256n) throw new Error();
    return n;
  } catch {
    throw httpError(400, `invalid ${name}`);
  }
};

const addr = (v: unknown, name: string): Hex => {
  try {
    return getAddress(String(v));
  } catch {
    throw httpError(400, `invalid ${name}`);
  }
};

const hex = (v: unknown, name: string): Hex => {
  if (typeof v !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(v)) throw httpError(400, `invalid ${name}`);
  return v as Hex;
};

/**
 * Zeroup gas sponsor ("relayer"). Submits user-signed deposits and
 * proof-authorised withdrawals and pays their gas. It never holds user funds:
 * deposits move straight from the user's wallet into the pool, and
 * withdrawals go to the recipient bound inside the ZK proof. Its only
 * compensation is the fee bound in that same proof.
 */
export function createSponsorApp(opts: SponsorOptions) {
  const { deployment: d, publicClient: client, wallet } = opts;
  const queue = new SerialQueue();
  const minDeposit = opts.minDeposit ?? 10_000n;
  const inFlightNullifiers = new Set<string>();
  const depositLimiter = new RateLimiter(opts.depositsPerHour ?? 20, 3_600_000);
  const ipLimiter = new RateLimiter(120, 60_000);
  const log = opts.log ?? (() => {});
  const app = express();
  app.use(express.json({ limit: "64kb" }));

  app.use((req, _res, next) => {
    if (!ipLimiter.take(req.ip ?? "unknown")) return next(httpError(429, "rate limited"));
    next();
  });

  const isBlocked = (account: Hex) =>
    client.readContract({ address: d.screener, abi: Screener.abi, functionName: "isBlocked", args: [account] });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/v1/info", (_req, res) => {
    res.json({
      address: wallet.account.address,
      network: caip2(d.chainId),
      chainId: d.chainId,
      pool: d.pool,
      token: d.token,
      withdrawFee: opts.withdrawFee.toString(),
      minDeposit: minDeposit.toString(),
    });
  });

  app.post("/v1/deposit", async (req: Request, res: Response) => {
    const b = req.body ?? {};
    const from = addr(b.from, "from");
    if (addr(b.to, "to") !== getAddress(d.pool)) throw httpError(400, "authorization must pay the pool");
    const value = big(b.value, "value");
    const validAfter = big(b.validAfter, "validAfter");
    const validBefore = big(b.validBefore, "validBefore");
    const nonce = hex(b.nonce, "nonce");
    const signature = hex(b.signature, "signature");
    const precommitment = big(b.precommitment, "precommitment");
    const encryptedNote = hex(b.encryptedNote, "encryptedNote");
    if (encryptedNote.length > 2 + 2 * 1024) throw httpError(400, "memo too large");
    if (await isBlocked(from)) throw httpError(403, "depositor is blocked by screening");
    if (value < minDeposit) throw httpError(400, `deposit below minimum ${minDeposit}`);
    let sig: ReturnType<typeof splitSignature>;
    try {
      sig = splitSignature(signature);
    } catch {
      throw httpError(400, "invalid signature");
    }
    if (!depositLimiter.take(from)) throw httpError(429, "too many deposits from this address");

    const args = [from, value, validAfter, validBefore, nonce, sig.v, sig.r, sig.s, precommitment, encryptedNote] as const;
    const receipt = await queue.run(async () => {
      const { request } = await client.simulateContract({
        account: wallet.account,
        address: d.pool,
        abi: ZeroupPool.abi,
        functionName: "depositWithAuthorization",
        args,
      });
      const hash = await wallet.writeContract(request);
      return client.waitForTransactionReceipt({ hash });
    });
    if (receipt.status !== "success") throw httpError(502, "deposit reverted");
    const [ev] = parseEventLogs({ abi: ZeroupPool.abi, eventName: "Deposit", logs: receipt.logs });
    log(`deposit ${value} from ${from} -> leaf ${ev.args.leafIndex} (${receipt.transactionHash})`);
    res.json({ txHash: receipt.transactionHash, leafIndex: Number(ev.args.leafIndex), commitment: ev.args.commitment.toString() });
  });

  app.post("/v1/withdraw", async (req: Request, res: Response) => {
    const b = req.body ?? {};
    const p = b.proof as SolidityProof | undefined;
    const r = b.request ?? {};
    if (!p?.a || !p?.b || !p?.c) throw httpError(400, "missing proof");
    const request = {
      root: big(r.root, "root"),
      nullifierHash: big(r.nullifierHash, "nullifierHash"),
      withdrawnValue: big(r.withdrawnValue, "withdrawnValue"),
      newCommitment: big(r.newCommitment, "newCommitment"),
      recipient: addr(r.recipient, "recipient"),
      relayer: addr(r.relayer, "relayer"),
      fee: big(r.fee, "fee"),
      encryptedNote: hex(r.encryptedNote, "encryptedNote"),
    };
    if (request.encryptedNote.length > 2 + 2 * 1024) throw httpError(400, "memo too large");
    if (request.relayer !== wallet.account.address) throw httpError(400, "relayer must be this sponsor");
    if (request.fee < opts.withdrawFee) throw httpError(400, `fee below minimum ${opts.withdrawFee}`);
    if (await isBlocked(request.recipient)) throw httpError(403, "recipient is blocked by screening");
    const nullifierKey = request.nullifierHash.toString();
    if (inFlightNullifiers.has(nullifierKey)) throw httpError(409, "withdrawal for this note already in progress");
    inFlightNullifiers.add(nullifierKey);
    try {
      const [spent, knownRoot, context] = await Promise.all([
        client.readContract({ address: d.pool, abi: ZeroupPool.abi, functionName: "nullifierSpent", args: [request.nullifierHash] }),
        client.readContract({ address: d.pool, abi: ZeroupPool.abi, functionName: "isKnownRoot", args: [request.root] }),
        client.readContract({
          address: d.pool,
          abi: ZeroupPool.abi,
          functionName: "withdrawContext",
          args: [request.recipient, request.relayer, request.fee, request.encryptedNote],
        }),
      ]);
      if (spent) throw httpError(409, "note already spent");
      if (!knownRoot) throw httpError(409, "unknown merkle root; resync and retry");
      const signals = publicSignals({ ...request, context });
      if (!(await verifyWithdrawProof(p, signals))) throw httpError(400, "invalid proof");

      const proof = {
        a: [BigInt(p.a[0]), BigInt(p.a[1])] as const,
        b: [
          [BigInt(p.b[0][0]), BigInt(p.b[0][1])],
          [BigInt(p.b[1][0]), BigInt(p.b[1][1])],
        ] as const,
        c: [BigInt(p.c[0]), BigInt(p.c[1])] as const,
      };
      const receipt = await queue.run(async () => {
        const { request: tx } = await client.simulateContract({
          account: wallet.account,
          address: d.pool,
          abi: ZeroupPool.abi,
          functionName: "withdraw",
          args: [proof, request],
        });
        const hash = await wallet.writeContract(tx);
        return client.waitForTransactionReceipt({ hash });
      });
      if (receipt.status !== "success") throw httpError(502, "withdrawal reverted");
      const [ev] = parseEventLogs({ abi: ZeroupPool.abi, eventName: "Withdrawal", logs: receipt.logs });
      log(`withdraw ${request.withdrawnValue} -> ${request.recipient} (fee ${request.fee}) ${receipt.transactionHash}`);
      res.json({ txHash: receipt.transactionHash, leafIndex: Number(ev.args.leafIndex) });
    } finally {
      inFlightNullifiers.delete(nullifierKey);
    }
  });

  app.use(errorHandler(log));
  return app;
}

export function errorHandler(log: (msg: string) => void) {
  return (err: unknown, _req: Request, res: Response, _next: unknown) => {
    // Malformed JSON bodies surface as body-parser errors carrying a status.
    const parserStatus = (err as { status?: number; type?: string })?.type === "entity.parse.failed" ? 400 : undefined;
    const status = parserStatus ?? statusFor(err);
    const message = errorMessage(err);
    if (status >= 500) log(`error: ${message}`);
    res.status(status).json({ error: message });
  };
}
