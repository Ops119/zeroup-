import express, { type Request, type Response } from "express";
import { getAddress, parseSignature, verifyTypedData, type Hex, type PublicClient } from "viem";
import { MockUSDC, Screener } from "../generated/contracts";
import type { Deployment } from "../core/deployment";
import { SerialQueue, type Wallet } from "../core/chain";
import { TRANSFER_WITH_AUTHORIZATION_TYPES, tokenDomain } from "../core/eip3009";
import {
  X402_VERSION,
  caip2,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
  type SupportedResponse,
  type VerifyResponse,
} from "../core/x402";
import { RateLimiter, errorMessage, httpError } from "./http";
import { errorHandler } from "./sponsor";

export interface FacilitatorOptions {
  deployment: Deployment;
  publicClient: PublicClient;
  wallet: Wallet;
  /** Seconds of clock skew tolerated on validAfter/validBefore. */
  clockSkew?: number;
  log?: (msg: string) => void;
}

/** EIP-3009 surface used by the facilitator (same on USDC and MockUSDC). */
const tokenAbi = MockUSDC.abi;

class InvalidPayment extends Error {
  constructor(readonly reason: string, readonly payer?: string) {
    super(reason);
  }
}

/**
 * Zeroup x402 facilitator for the "exact" scheme on EVM (EIP-3009). Implements
 * /verify, /settle and /supported from the x402 v2 spec. It only ever submits
 * transfers the payer signed, pays the gas itself, and refuses screened
 * addresses. It accepts payments from fresh one-time accounts like any other.
 */
export function createFacilitatorApp(opts: FacilitatorOptions) {
  const { deployment: d, publicClient: client, wallet } = opts;
  const network = caip2(d.chainId);
  const skew = BigInt(opts.clockSkew ?? 6);
  const queue = new SerialQueue();
  const inFlight = new Set<string>();
  const ipLimiter = new RateLimiter(600, 60_000);
  const log = opts.log ?? (() => {});
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use((req, _res, next) => {
    if (!ipLimiter.take(req.ip ?? "unknown")) return next(httpError(429, "rate limited"));
    next();
  });

  async function verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<{ payer: Hex }> {
    if (payload?.x402Version !== X402_VERSION) throw new InvalidPayment("invalid_x402_version");
    if (requirements?.scheme !== "exact" || payload.accepted?.scheme !== "exact") throw new InvalidPayment("unsupported_scheme");
    if (requirements.network !== network || payload.accepted.network !== network) throw new InvalidPayment("invalid_network");
    const auth = payload.payload?.authorization;
    const signature = payload.payload?.signature;
    if (!auth || !signature) throw new InvalidPayment("invalid_payload");

    let from: Hex, to: Hex, asset: Hex, payTo: Hex;
    try {
      from = getAddress(auth.from);
      to = getAddress(auth.to);
      asset = getAddress(requirements.asset);
      payTo = getAddress(requirements.payTo);
    } catch {
      throw new InvalidPayment("invalid_payload");
    }
    if (asset !== getAddress(d.token) || getAddress(payload.accepted.asset) !== asset) throw new InvalidPayment("invalid_asset");
    if (to !== payTo || getAddress(payload.accepted.payTo) !== payTo) {
      throw new InvalidPayment("invalid_exact_evm_payload_recipient_mismatch", from);
    }
    const value = BigInt(auth.value);
    if (value !== BigInt(requirements.amount) || payload.accepted.amount !== requirements.amount) {
      throw new InvalidPayment("invalid_exact_evm_payload_authorization_value", from);
    }
    const now = BigInt(Math.floor(Date.now() / 1000));
    const validAfter = BigInt(auth.validAfter);
    const validBefore = BigInt(auth.validBefore);
    if (validAfter > now + skew) throw new InvalidPayment("invalid_exact_evm_payload_authorization_valid_after", from);
    if (validBefore < now + skew) throw new InvalidPayment("invalid_exact_evm_payload_authorization_valid_before", from);
    if (validBefore - now > BigInt(requirements.maxTimeoutSeconds) + skew) {
      throw new InvalidPayment("invalid_exact_evm_payload_authorization_valid_before", from);
    }

    const extra = (requirements.extra ?? {}) as { name?: string; version?: string };
    const valid = await verifyTypedData({
      address: from,
      domain: tokenDomain(extra.name ?? d.tokenName, extra.version ?? d.tokenVersion, d.chainId, asset),
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: { from, to, value, validAfter, validBefore, nonce: auth.nonce },
      signature,
    });
    if (!valid) throw new InvalidPayment("invalid_exact_evm_payload_signature", from);

    const [balance, used, fromBlocked, toBlocked] = await Promise.all([
      client.readContract({ address: asset, abi: tokenAbi, functionName: "balanceOf", args: [from] }),
      client.readContract({ address: asset, abi: tokenAbi, functionName: "authorizationState", args: [from, auth.nonce] }),
      client.readContract({ address: d.screener, abi: Screener.abi, functionName: "isBlocked", args: [from] }),
      client.readContract({ address: d.screener, abi: Screener.abi, functionName: "isBlocked", args: [to] }),
    ]);
    if (fromBlocked || toBlocked) throw new InvalidPayment("address_blocked", from);
    if (used) throw new InvalidPayment("invalid_exact_evm_payload_authorization_nonce_used", from);
    if (balance < value) throw new InvalidPayment("insufficient_funds", from);
    return { payer: from };
  }

  function transferArgs(payload: PaymentPayload) {
    const a = payload.payload.authorization;
    const { v, r, s } = parseSignature(payload.payload.signature);
    return [
      getAddress(a.from),
      getAddress(a.to),
      BigInt(a.value),
      BigInt(a.validAfter),
      BigInt(a.validBefore),
      a.nonce,
      Number(v ?? 0n),
      r,
      s,
    ] as const;
  }

  app.get("/supported", (_req, res) => {
    const body: SupportedResponse = {
      kinds: [{ x402Version: X402_VERSION, scheme: "exact", network }],
      extensions: [],
      signers: { "eip155:*": [wallet.account.address] },
    };
    res.json(body);
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/verify", async (req: Request, res: Response) => {
    const { paymentPayload, paymentRequirements } = req.body ?? {};
    try {
      const { payer } = await verify(paymentPayload, paymentRequirements);
      // Simulation catches anything the static checks missed.
      await client.simulateContract({
        account: wallet.account,
        address: getAddress(paymentRequirements.asset),
        abi: tokenAbi,
        functionName: "transferWithAuthorization",
        args: transferArgs(paymentPayload),
      });
      const body: VerifyResponse = { isValid: true, payer };
      res.json(body);
    } catch (err) {
      const body: VerifyResponse = {
        isValid: false,
        invalidReason: err instanceof InvalidPayment ? err.reason : `simulation_failed: ${errorMessage(err)}`,
        payer: err instanceof InvalidPayment ? err.payer : paymentPayload?.payload?.authorization?.from,
      };
      res.json(body);
    }
  });

  app.post("/settle", async (req: Request, res: Response) => {
    const { paymentPayload, paymentRequirements } = req.body ?? {};
    const fail = (reason: string, payer?: string) => {
      const body: SettleResponse = { success: false, errorReason: reason, payer, transaction: "", network };
      res.json(body);
    };
    const key = `${paymentPayload?.payload?.authorization?.from}:${paymentPayload?.payload?.authorization?.nonce}`.toLowerCase();
    if (inFlight.has(key)) return fail("settlement_in_progress");
    inFlight.add(key);
    try {
      const { payer } = await verify(paymentPayload, paymentRequirements);
      const receipt = await queue.run(async () => {
        const { request } = await client.simulateContract({
          account: wallet.account,
          address: getAddress(paymentRequirements.asset),
          abi: tokenAbi,
          functionName: "transferWithAuthorization",
          args: transferArgs(paymentPayload),
        });
        const hash = await wallet.writeContract(request);
        return client.waitForTransactionReceipt({ hash });
      });
      if (receipt.status !== "success") return fail("transaction_reverted", payer);
      log(`settled ${paymentRequirements.amount} ${payer} -> ${paymentRequirements.payTo} (${receipt.transactionHash})`);
      const body: SettleResponse = { success: true, payer, transaction: receipt.transactionHash, network };
      res.json(body);
    } catch (err) {
      if (err instanceof InvalidPayment) return fail(err.reason, err.payer);
      log(`settle error: ${errorMessage(err)}`);
      fail(`unexpected_settle_error: ${errorMessage(err)}`);
    } finally {
      inFlight.delete(key);
    }
  });

  app.use(errorHandler(log));
  return app;
}
