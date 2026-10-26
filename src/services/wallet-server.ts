import path from "path";
import express, { type NextFunction, type Request, type Response } from "express";
import { getAddress, hexToBytes, parseUnits, type Hex, type LocalAccount, type PublicClient } from "viem";
import { formatUnits6 } from "../core/chain";
import { stealthMetaAddress } from "../core/stealth";
import type { ZeroupKeys } from "../core/keys";
import { auditWithViewingKey } from "../wallet/auditor";
import { createPrivateFetch } from "../wallet/x402-fetch";
import type { ZeroupWallet } from "../wallet/wallet";
import { MockUSDC } from "../generated/contracts";
import { errorHandler } from "./sponsor";
import { httpError } from "./http";

export interface WalletServerOptions {
  wallet: ZeroupWallet;
  keys: Pick<ZeroupKeys, "stealthSpendingKey" | "stealthViewingKey">;
  publicClient: PublicClient;
  /** Public wallet that funds deposits (demo/dev). In production the user signs in their own wallet. */
  funder?: LocalAccount;
  /** Optional bearer token required on /api routes. */
  apiToken?: string;
  /** Demo merchant, for the "what the merchant saw" panel. */
  merchantUrl?: string;
  /** Host headers accepted besides localhost/127.0.0.1/[::1] (e.g. a reverse-proxy name). */
  allowedHosts?: string[];
  log?: (m: string) => void;
}

/** Local agent-wallet daemon: JSON API for agents plus the dashboard UI. */
export function createWalletServer(opts: WalletServerOptions) {
  const { wallet, publicClient: client } = opts;
  const d = wallet.deployment;
  const privateFetch = createPrivateFetch(wallet);
  const log = opts.log ?? (() => {});
  const app = express();
  const allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]", ...(opts.allowedHosts ?? [])]);

  // DNS-rebinding guard: a web page that points its own domain at 127.0.0.1
  // must not be able to read the viewing key or trigger payments.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const host = (req.get("host") ?? "").replace(/:\d+$/, "").toLowerCase();
    if (!allowedHosts.has(host)) return next(httpError(403, "host not allowed"));
    next();
  });
  app.use(express.json({ limit: "32kb" }));

  app.use("/api", (req: Request, _res: Response, next: NextFunction) => {
    if (opts.apiToken && req.get("authorization") !== `Bearer ${opts.apiToken}`) return next(httpError(401, "unauthorized"));
    // JSON-only POSTs force a CORS preflight, so cross-site forms cannot trigger actions.
    if (req.method === "POST" && !req.is("application/json")) return next(httpError(415, "content-type must be application/json"));
    next();
  });

  const amount = (v: unknown) => {
    try {
      const a = parseUnits(String(v), d.tokenDecimals);
      if (a <= 0n) throw new Error();
      return a;
    } catch {
      throw httpError(400, "invalid amount");
    }
  };

  app.get("/api/status", async (_req, res) => {
    await wallet.sync();
    const funderBalance = opts.funder
      ? await client.readContract({ address: d.token, abi: MockUSDC.abi, functionName: "balanceOf", args: [opts.funder.address] })
      : undefined;
    res.json({
      network: wallet.network,
      pool: d.pool,
      token: d.token,
      decimals: d.tokenDecimals,
      balance: wallet.balance().toString(),
      balanceFormatted: formatUnits6(wallet.balance(), d.tokenDecimals),
      notes: wallet.notes(),
      payments: wallet.payments().reverse(),
      policy: { maxPerPayment: wallet.policy.maxPerPayment.toString(), dailyBudget: wallet.policy.dailyBudget.toString() },
      funder: opts.funder ? { address: opts.funder.address, balance: funderBalance?.toString() } : null,
      stealthMetaAddress: stealthMetaAddress(opts.keys.stealthSpendingKey, opts.keys.stealthViewingKey).encoded,
      merchantUrl: opts.merchantUrl ?? null,
    });
  });

  app.post("/api/deposit", async (req, res) => {
    if (!opts.funder) throw httpError(400, "no funding wallet configured (FUNDER_PRIVATE_KEY)");
    const r = await wallet.deposit(opts.funder, amount(req.body?.amount));
    log(`deposit ${req.body?.amount} -> ${r.txHash}`);
    res.json(r);
  });

  app.post("/api/fetch", async (req, res) => {
    const url = String(req.body?.url ?? "");
    if (!/^https?:\/\//.test(url)) throw httpError(400, "url must be http(s)");
    const method = String(req.body?.method ?? "GET").toUpperCase();
    const { response, payment } = await privateFetch(url, {
      method,
      body: method === "GET" || req.body?.body === undefined ? undefined : JSON.stringify(req.body.body),
      headers: req.body?.body === undefined ? undefined : { "content-type": "application/json" },
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    res.json({ status: response.status, body, payment: payment ?? null });
  });

  app.post("/api/exit", async (req, res) => {
    let to: Hex;
    try {
      to = getAddress(String(req.body?.to));
    } catch {
      throw httpError(400, "invalid address");
    }
    res.json({ txs: await wallet.exit(to, amount(req.body?.amount)) });
  });

  app.post("/api/reclaim", async (_req, res) => {
    const out = await wallet.reclaim();
    res.json({ reclaimed: out.map((r) => ({ payer: r.payer, amount: r.amount.toString(), txHash: r.txHash })) });
  });

  app.get("/api/viewing-key", (_req, res) => {
    res.json({ viewingKey: wallet.viewingKey });
  });

  app.post("/api/audit", async (req, res) => {
    const vk = String(req.body?.viewingKey ?? "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(vk)) throw httpError(400, "viewing key must be 32 bytes hex");
    res.json(await auditWithViewingKey(hexToBytes(vk as Hex), client, d));
  });

  app.get("/api/merchant-ledger", async (_req, res) => {
    if (!opts.merchantUrl) return res.json([]);
    const r = await fetch(`${opts.merchantUrl}/merchant/ledger`).catch(() => null);
    res.json(r?.ok ? await r.json() : []);
  });

  app.use(express.static(path.join(__dirname, "..", "..", "web")));
  app.use(errorHandler(log));
  return app;
}
