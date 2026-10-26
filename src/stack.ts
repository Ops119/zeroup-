import { spawn, type ChildProcess } from "child_process";
import path from "path";
import type { Server } from "http";
import { getAddress, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MockUSDC, Screener } from "./generated/contracts";
import { DEV_KEYS, type Config } from "./config";
import { deployZeroup, type Deployment } from "./core/deployment";
import { makePublicClient, makeWalletClient } from "./core/chain";
import { caip2 } from "./core/x402";
import { createSponsorApp } from "./services/sponsor";
import { createFacilitatorApp } from "./services/facilitator";
import { createMerchantApp, type LedgerEntry } from "./services/merchant";
import { listen } from "./services/http";

const ROOT = path.join(__dirname, "..");

async function rpcReady(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Starts a Hardhat JSON-RPC node, or reuses one already listening on the URL. */
export async function startLocalChain(rpcUrl: string): Promise<{ stop: () => void; reused: boolean }> {
  if (await rpcReady(rpcUrl)) return { stop: () => {}, reused: true };
  const { hostname, port } = new URL(rpcUrl);
  const child: ChildProcess = spawn(
    process.execPath,
    [require.resolve("hardhat/internal/cli/cli"), "node", "--hostname", hostname, "--port", port],
    { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr?.on("data", (b) => (stderr += b.toString()));
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`hardhat node exited: ${stderr}`);
    if (await rpcReady(rpcUrl)) return { stop: () => child.kill(), reused: false };
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error("hardhat node did not start");
}

/**
 * Local network bootstrap: deploys everything, mints demo USDC to the funding
 * wallet and puts one address on the screening list.
 */
export async function deployLocal(cfg: Config, log: (m: string) => void = () => {}): Promise<Deployment> {
  const client = makePublicClient(cfg.rpcUrl, cfg.chainId);
  const deployer = makeWalletClient(cfg.rpcUrl, cfg.chainId, DEV_KEYS.deployer);
  const d = await deployZeroup(deployer, client, { network: cfg.network, log });
  const funder = privateKeyToAccount(cfg.keys.funder ?? DEV_KEYS.funder).address;
  const blocked = privateKeyToAccount(DEV_KEYS.blocked).address;
  await waitFor(client, deployer.writeContract({ address: d.token, abi: MockUSDC.abi, functionName: "mint", args: [funder, 1_000_000_000n] }));
  await waitFor(client, deployer.writeContract({ address: d.token, abi: MockUSDC.abi, functionName: "mint", args: [blocked, 1_000_000_000n] }));
  await waitFor(
    client,
    deployer.writeContract({ address: d.screener, abi: Screener.abi, functionName: "setBlocked", args: [[blocked], true, "demo: sanctioned"] }),
  );
  log(`minted 1000 USDC to funding wallet ${funder}`);
  log(`screening list: ${blocked} blocked`);
  return d;
}

async function waitFor(client: PublicClient, tx: Promise<Hex>) {
  const receipt = await client.waitForTransactionReceipt({ hash: await tx });
  if (receipt.status !== "success") throw new Error(`tx ${receipt.transactionHash} reverted`);
}

export interface RunningServices {
  sponsorUrl: string;
  facilitatorUrl: string;
  merchantUrl: string;
  merchantPayTo: Hex;
  merchantLedger: LedgerEntry[];
  close: () => Promise<void>;
}

export async function startServices(
  cfg: Config,
  d: Deployment,
  opts: { log?: (svc: string, m: string) => void; ports?: Partial<Config["ports"]> } = {},
): Promise<RunningServices> {
  const log = opts.log ?? (() => {});
  const ports = { ...cfg.ports, ...opts.ports };
  const client = makePublicClient(cfg.rpcUrl, cfg.chainId);
  const servers: Server[] = [];

  const sponsorKey = cfg.keys.sponsor ?? DEV_KEYS.sponsor;
  const facilitatorKey = cfg.keys.facilitator ?? DEV_KEYS.facilitator;
  const merchantPayTo = getAddress(cfg.merchantPayTo ?? privateKeyToAccount(DEV_KEYS.merchant).address);

  const sponsor = createSponsorApp({
    deployment: d,
    publicClient: client,
    wallet: makeWalletClient(cfg.rpcUrl, cfg.chainId, sponsorKey),
    withdrawFee: cfg.sponsorWithdrawFee,
    minDeposit: cfg.sponsorMinDeposit,
    log: (m) => log("sponsor", m),
  });
  servers.push(await listen(sponsor, ports.sponsor));

  const facilitator = createFacilitatorApp({
    deployment: d,
    publicClient: client,
    wallet: makeWalletClient(cfg.rpcUrl, cfg.chainId, facilitatorKey),
    apiKey: cfg.facilitatorApiKey,
    log: (m) => log("facilitator", m),
  });
  servers.push(await listen(facilitator, ports.facilitator));

  const facilitatorUrl = `http://127.0.0.1:${ports.facilitator}`;
  const merchant = createMerchantApp({
    facilitatorUrl,
    network: caip2(d.chainId),
    asset: d.token,
    assetName: d.tokenName,
    assetVersion: d.tokenVersion,
    payTo: merchantPayTo,
    facilitatorApiKey: cfg.facilitatorApiKey,
  });
  servers.push(await listen(merchant.app, ports.merchant));

  return {
    sponsorUrl: `http://127.0.0.1:${ports.sponsor}`,
    facilitatorUrl,
    merchantUrl: `http://127.0.0.1:${ports.merchant}`,
    merchantPayTo,
    merchantLedger: merchant.ledger,
    close: async () => {
      await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    },
  };
}
