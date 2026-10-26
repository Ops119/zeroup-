import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { getAddress, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DEV_KEYS, type Config } from "../config";
import { makePublicClient, makeWalletClient, SerialQueue } from "../core/chain";
import type { Deployment } from "../core/deployment";
import { keysFromMnemonic, newMnemonic } from "../core/keys";
import { MockUSDC } from "../generated/contracts";
import { deployLocal, startLocalChain, startServices, type RunningServices } from "../stack";
import { auditWithViewingKey } from "../wallet/auditor";
import { ZeroupWallet } from "../wallet/wallet";
import { createPrivateFetch } from "../wallet/x402-fetch";

/** Everything a visitor sees, streamed as it happens. */
export type DemoEvent =
  | { t: "queued"; ahead: number }
  | { t: "step"; n: number; title: string }
  | { t: "log"; msg: string }
  | { t: "chain"; chainId: number; pool: Hex; token: Hex; merchant: Hex }
  | { t: "funder"; address: Hex; usdc: string; eth: string }
  | { t: "deposit"; amount: string; tx: Hex; ethSpent: string; shielded: string }
  | {
      t: "payment";
      endpoint: string;
      price: string;
      payer: Hex;
      withdrawTx: string;
      settleTx: string;
      status: number;
      body: unknown;
      shielded: string;
    }
  | { t: "merchant"; entries: { payer: string; amount: string; resource: string }[] }
  | { t: "payers"; payers: { address: Hex; txCount: number; eth: string; usdc: string }[]; linkedToFunder: boolean; allDistinct: boolean }
  | {
      t: "audit";
      entries: { kind: string; amount: string; detail: string }[];
      totals: { deposited: string; paid: string; fees: string; shieldedBalance: string };
    }
  | { t: "screening"; blocked: Hex; rejected: boolean; reason: string }
  | { t: "done"; ms: number }
  | { t: "error"; msg: string };

const ENDPOINTS = ["/api/weather?city=Lisbon", "/api/quote/ETH", "/api/report"];
const DEPOSIT = 1_000_000n; // 1 USDC

/**
 * Hosts a private local chain with the full Zeroup stack and runs the
 * end-to-end scenario on demand, one visitor at a time.
 */
export class LiveDemo {
  private cfg!: Config;
  private d!: Deployment;
  private svc!: RunningServices;
  private client!: PublicClient;
  private readonly queue = new SerialQueue();
  private waiting = 0;
  private busy = false;
  private bootError?: string;
  ready = false;
  runs = 0;

  constructor(private readonly baseCfg: Config, private readonly maxQueue = 8) {}

  async boot(log: (m: string) => void = () => {}): Promise<void> {
    try {
      // Internal-only ports so nothing but the web server is exposed.
      this.cfg = {
        ...this.baseCfg,
        network: "localhost",
        isLocal: true,
        chainId: 31337,
        rpcUrl: process.env.DEMO_RPC_URL ?? "http://127.0.0.1:8545",
        ports: { sponsor: 4110, facilitator: 4120, merchant: 4130, wallet: 4140 },
      };
      await startLocalChain(this.cfg.rpcUrl);
      this.d = await deployLocal(this.cfg, log);
      this.svc = await startServices(this.cfg, this.d, { log: (s, m) => log(`[${s}] ${m}`) });
      this.client = makePublicClient(this.cfg.rpcUrl, this.cfg.chainId);
      this.ready = true;
      log("live demo ready");
    } catch (err) {
      this.bootError = (err as Error).message;
      log(`live demo failed to start: ${this.bootError}`);
    }
  }

  status() {
    return {
      ready: this.ready,
      error: this.bootError ?? null,
      runs: this.runs,
      queue: this.waiting,
      chainId: this.ready ? this.d.chainId : null,
      pool: this.ready ? this.d.pool : null,
    };
  }

  /** Queues one full run; `emit` receives every event. Rejects when the queue is full. */
  run(emit: (e: DemoEvent) => void): Promise<void> {
    if (!this.ready) throw new Error(this.bootError ? `demo unavailable: ${this.bootError}` : "demo is still starting, try again in a few seconds");
    if (this.waiting >= this.maxQueue) throw new Error("the demo is busy right now, try again in a minute");
    emit({ t: "queued", ahead: this.waiting + (this.busy ? 1 : 0) });
    this.waiting++;
    return this.queue.run(async () => {
      this.waiting--;
      this.busy = true;
      try {
        await this.runOnce(emit);
      } catch (err) {
        emit({ t: "error", msg: (err as Error).message });
      } finally {
        this.busy = false;
      }
    });
  }

  private async runOnce(emit: (e: DemoEvent) => void): Promise<void> {
    const started = Date.now();
    const { client, d, svc, cfg } = this;
    const usdc = (address: Hex) => client.readContract({ address: d.token, abi: MockUSDC.abi, functionName: "balanceOf", args: [address] });
    emit({ t: "chain", chainId: d.chainId, pool: d.pool, token: d.token, merchant: svc.merchantPayTo });

    // 1. A brand-new public wallet holding test USDC and zero ETH.
    emit({ t: "step", n: 1, title: "Create a public wallet with 5 test USDC and no ETH" });
    const funder = privateKeyToAccount(generatePrivateKey());
    const deployer = makeWalletClient(cfg.rpcUrl, cfg.chainId, DEV_KEYS.deployer);
    const mint = await deployer.writeContract({ address: d.token, abi: MockUSDC.abi, functionName: "mint", args: [funder.address, 5_000_000n] });
    await client.waitForTransactionReceipt({ hash: mint });
    emit({ t: "funder", address: funder.address, usdc: (await usdc(funder.address)).toString(), eth: (await client.getBalance({ address: funder.address })).toString() });

    const dir = path.join(os.tmpdir(), "zeroup-live", randomUUID());
    const keys = keysFromMnemonic(newMnemonic());
    const wallet = await ZeroupWallet.open({
      keys,
      deployment: d,
      publicClient: client,
      sponsorUrl: svc.sponsorUrl,
      stateFile: path.join(dir, "state.bin"),
      log: (msg) => emit({ t: "log", msg }),
    });
    try {
      // 2. Gasless deposit into the shielded pool.
      emit({ t: "step", n: 2, title: "Gasless deposit of 1 USDC into the shielded pool" });
      const ethBefore = await client.getBalance({ address: funder.address });
      const dep = await wallet.deposit(funder, DEPOSIT);
      const ethSpent = ethBefore - (await client.getBalance({ address: funder.address }));
      emit({ t: "deposit", amount: DEPOSIT.toString(), tx: dep.txHash, ethSpent: ethSpent.toString(), shielded: wallet.balance().toString() });

      // 3. Three paid API calls, each from a fresh one-time account.
      emit({ t: "step", n: 3, title: "An AI agent pays three x402 APIs privately" });
      const privateFetch = createPrivateFetch(wallet);
      const payers: Hex[] = [];
      for (const ep of ENDPOINTS) {
        const { response, payment } = await privateFetch(`${svc.merchantUrl}${ep}`);
        const body = await response.json().catch(() => null);
        if (!payment) throw new Error(`no payment was needed for ${ep}`);
        payers.push(getAddress(payment.record.payer));
        emit({
          t: "payment",
          endpoint: ep.split("?")[0],
          price: payment.record.amount,
          payer: getAddress(payment.record.payer),
          withdrawTx: payment.record.withdrawTxs[0] ?? "",
          settleTx: payment.settlement?.transaction ?? "",
          status: response.status,
          body,
          shielded: wallet.balance().toString(),
        });
      }

      // 4. What the merchant and chain observers can see.
      emit({ t: "step", n: 4, title: "What the merchant and the chain can see" });
      const mine = new Set(payers.map((p) => p.toLowerCase()));
      emit({
        t: "merchant",
        entries: svc.merchantLedger
          .filter((e) => mine.has(e.payer.toLowerCase()))
          .map((e) => ({ payer: e.payer, amount: e.amount, resource: new URL(e.resource).pathname })),
      });
      emit({
        t: "payers",
        payers: await Promise.all(
          payers.map(async (address) => ({
            address,
            txCount: await client.getTransactionCount({ address }),
            eth: (await client.getBalance({ address })).toString(),
            usdc: (await usdc(address)).toString(),
          })),
        ),
        linkedToFunder: payers.includes(getAddress(funder.address)),
        allDistinct: new Set(payers).size === payers.length,
      });

      // 5. The owner's viewing key shows everything, read-only.
      emit({ t: "step", n: 5, title: "Auditor view with the viewing key (read-only)" });
      const report = await auditWithViewingKey(keys.viewingKey, client, d);
      emit({
        t: "audit",
        entries: report.entries.map((e) => ({
          kind: e.kind,
          amount: e.amount,
          detail:
            e.kind === "deposit"
              ? `from ${e.depositor}`
              : e.kind === "payment"
                ? `${new URL(e.resource!).pathname} via ${e.payer}`
                : `to ${e.to}`,
        })),
        totals: report.totals,
      });

      // 6. Screening: a sanctioned address cannot get in.
      emit({ t: "step", n: 6, title: "Compliance: a screened address tries to deposit" });
      const blocked = privateKeyToAccount(DEV_KEYS.blocked);
      try {
        await wallet.deposit(blocked, DEPOSIT);
        emit({ t: "screening", blocked: blocked.address, rejected: false, reason: "deposit unexpectedly accepted" });
      } catch (err) {
        emit({ t: "screening", blocked: blocked.address, rejected: true, reason: (err as Error).message.replace(/^https?:\/\/[^ ]+: /, "") });
      }
    } finally {
      await wallet.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    this.runs++;
    emit({ t: "done", ms: Date.now() - started });
  }
}
