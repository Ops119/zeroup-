import express, { type Request, type RequestHandler, type Response } from "express";
import { getAddress, type Hex } from "viem";
import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  X402_VERSION,
  decodeHeader,
  encodeHeader,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type ResourceInfo,
  type SettleResponse,
  type VerifyResponse,
} from "../core/x402";
import { errorMessage, fetchWithTimeout } from "./http";

export interface PaywallConfig {
  facilitatorUrl: string;
  network: string;
  asset: Hex;
  assetName: string;
  assetVersion: string;
  payTo: Hex;
  maxTimeoutSeconds?: number;
  /** Sent as "Authorization: Bearer <key>" to a facilitator that requires it. */
  facilitatorApiKey?: string;
  onSettled?: (info: { resource: string; amount: string; payer: string; transaction: string }) => void;
}

export interface PaidRoute {
  /** Price in atomic units (USDC has 6 decimals: "10000" = $0.01). */
  price: string;
  description: string;
  handler: (req: Request) => Promise<unknown> | unknown;
}

async function facilitator<T>(cfg: PaywallConfig, path: string, payload: PaymentPayload, requirements: PaymentRequirements): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.facilitatorApiKey) headers.authorization = `Bearer ${cfg.facilitatorApiKey}`;
  const res = await fetchWithTimeout(`${cfg.facilitatorUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ x402Version: X402_VERSION, paymentPayload: payload, paymentRequirements: requirements }),
  });
  if (!res.ok) throw new Error(`facilitator ${path} returned ${res.status}`);
  return (await res.json()) as T;
}

/**
 * x402 v2 paywall for any Express route ("authorization" flow):
 * verify -> run handler -> settle -> respond with PAYMENT-RESPONSE.
 */
export function paid(cfg: PaywallConfig, route: PaidRoute): RequestHandler {
  return async (req: Request, res: Response) => {
    const resource: ResourceInfo = {
      url: `${req.protocol}://${req.get("host")}${req.originalUrl.split("?")[0]}`,
      description: route.description,
      mimeType: "application/json",
    };
    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: cfg.network,
      amount: route.price,
      asset: cfg.asset,
      payTo: cfg.payTo,
      maxTimeoutSeconds: cfg.maxTimeoutSeconds ?? 120,
      extra: { name: cfg.assetName, version: cfg.assetVersion },
    };
    const requirePayment = (error: string, status = 402) => {
      const body: PaymentRequired = { x402Version: X402_VERSION, error, resource, accepts: [requirements] };
      res.status(status).set(HEADER_PAYMENT_REQUIRED, encodeHeader(body)).json({});
    };

    const header = req.get(HEADER_PAYMENT_SIGNATURE);
    if (!header) return requirePayment("PAYMENT-SIGNATURE header is required");

    let payload: PaymentPayload;
    try {
      payload = decodeHeader<PaymentPayload>(header);
    } catch {
      return requirePayment("malformed PAYMENT-SIGNATURE header", 400);
    }
    if (!matches(payload, requirements)) return requirePayment("payment does not match requirements");

    const verified = await facilitator<VerifyResponse>(cfg, "/verify", payload, requirements);
    if (!verified.isValid) return requirePayment(verified.invalidReason ?? "invalid payment");

    const result = await route.handler(req);

    const settled = await facilitator<SettleResponse>(cfg, "/settle", payload, requirements);
    res.set(HEADER_PAYMENT_RESPONSE, encodeHeader(settled));
    if (!settled.success) return res.status(402).json({});
    cfg.onSettled?.({ resource: resource.url, amount: route.price, payer: settled.payer ?? "", transaction: settled.transaction });
    res.json(result);
  };
}

function matches(payload: PaymentPayload, req: PaymentRequirements): boolean {
  const a = payload?.accepted;
  try {
    return (
      !!a &&
      payload.x402Version === X402_VERSION &&
      a.scheme === req.scheme &&
      a.network === req.network &&
      a.amount === req.amount &&
      getAddress(a.asset) === getAddress(req.asset) &&
      getAddress(a.payTo) === getAddress(req.payTo)
    );
  } catch {
    return false;
  }
}

/** What the merchant observed: the only view a merchant ever has of payers. */
export interface LedgerEntry {
  ts: number;
  resource: string;
  amount: string;
  payer: string;
  transaction: string;
}

/** Demo paid API: weather, market quotes and a research report, priced per call. */
export function createMerchantApp(cfg: Omit<PaywallConfig, "onSettled">) {
  const ledger: LedgerEntry[] = [];
  const pw: PaywallConfig = { ...cfg, onSettled: (i) => ledger.push({ ts: Date.now(), ...i }) };
  const app = express();

  const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

  app.get("/", (_req, res) => {
    res.json({
      service: "Zeroup demo data API",
      payTo: cfg.payTo,
      network: cfg.network,
      endpoints: [
        { path: "/api/weather?city=Lisbon", price: "10000", description: "Current weather" },
        { path: "/api/quote/ETH", price: "20000", description: "Market quote" },
        { path: "/api/report", price: "50000", description: "Agent research report" },
      ],
    });
  });

  app.get(
    "/api/weather",
    paid(pw, {
      price: "10000",
      description: "Current weather for a city",
      handler: (req) => {
        const city = String(req.query.city ?? "Lisbon");
        const h = hash(city + new Date().toISOString().slice(0, 13));
        return { city, tempC: 8 + (h % 22), conditions: ["clear", "cloudy", "rain", "windy"][h % 4], source: "zeroup-demo" };
      },
    }),
  );

  app.get(
    "/api/quote/:symbol",
    paid(pw, {
      price: "20000",
      description: "Market quote for a symbol",
      handler: (req) => {
        const symbol = String(req.params.symbol).toUpperCase();
        const h = hash(symbol + new Date().toISOString().slice(0, 16));
        return { symbol, price: (100 + (h % 400000) / 100).toFixed(2), currency: "USD", ts: new Date().toISOString() };
      },
    }),
  );

  app.get(
    "/api/report",
    paid(pw, {
      price: "50000",
      description: "Agent research report",
      handler: () => ({
        title: "Private agent payments",
        summary: "x402 payments made from one-time accounts funded by a shielded pool cannot be linked to the payer's wallet.",
        generatedAt: new Date().toISOString(),
      }),
    }),
  );

  app.get("/merchant/ledger", (_req, res) => {
    res.json(ledger);
  });

  app.use((err: unknown, _req: Request, res: Response, _next: unknown) => {
    res.status(502).json({ error: `payment processing failed: ${errorMessage(err)}` });
  });

  return { app, ledger };
}
