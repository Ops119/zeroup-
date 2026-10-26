/**
 * End-to-end demo on a local chain:
 *   1. deploy pool + USDC + screener, start sponsor, facilitator and a paid API
 *   2. gasless deposit of 5 USDC from the user's public wallet into the pool
 *   3. an agent calls three paid endpoints; each is paid from a fresh account
 *   4. show what the merchant saw vs. what the auditor (viewing key) sees
 *   5. show that a screened address cannot deposit
 */
import fs from "fs";
import os from "os";
import path from "path";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEV_KEYS, loadConfig } from "../config";
import { formatUnits6, makePublicClient } from "../core/chain";
import { keysFromMnemonic, newMnemonic } from "../core/keys";
import { shutdownProver } from "../core/prover";
import { deployLocal, startLocalChain, startServices } from "../stack";
import { ZeroupWallet } from "../wallet/wallet";
import { createPrivateFetch } from "../wallet/x402-fetch";
import { auditWithViewingKey } from "../wallet/auditor";
import { MockUSDC } from "../generated/contracts";

const usd = (v: bigint | string) => `${formatUnits6(BigInt(v))} USDC`;
const step = (n: number, s: string) => console.log(`\n\x1b[1m${n}. ${s}\x1b[0m`);

async function main() {
  const cfg = { ...loadConfig(), network: "localhost", isLocal: true, chainId: 31337 };
  cfg.rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545";

  step(1, "Start local chain, deploy contracts, start services");
  const chain = await startLocalChain(cfg.rpcUrl);
  const d = await deployLocal(cfg, (m) => console.log(`   ${m}`));
  const svc = await startServices(cfg, d);
  console.log(`   sponsor ${svc.sponsorUrl} · facilitator ${svc.facilitatorUrl} · paid API ${svc.merchantUrl}`);

  const client = makePublicClient(cfg.rpcUrl, cfg.chainId);
  const funder = privateKeyToAccount(DEV_KEYS.funder);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zeroup-demo-"));
  const mnemonic = newMnemonic();
  const keys = keysFromMnemonic(mnemonic);
  const wallet = await ZeroupWallet.open({
    keys,
    deployment: d,
    publicClient: client,
    sponsorUrl: svc.sponsorUrl,
    stateFile: path.join(dataDir, "state.bin"),
    log: (m) => console.log(`   · ${m}`),
  });

  step(2, `Gasless deposit: 5 USDC from public wallet ${funder.address}`);
  const ethBefore = await client.getBalance({ address: funder.address });
  await wallet.deposit(funder, 5_000_000n);
  const ethAfter = await client.getBalance({ address: funder.address });
  console.log(`   shielded balance: ${usd(wallet.balance())}; ETH spent by user on gas: ${ethBefore - ethAfter} wei`);

  step(3, "Agent pays three x402 endpoints privately");
  const privateFetch = createPrivateFetch(wallet);
  for (const p of ["/api/weather?city=Lisbon", "/api/quote/ETH", "/api/report"]) {
    const { response, payment } = await privateFetch(`${svc.merchantUrl}${p}`);
    const body = await response.json();
    console.log(`   GET ${p} -> HTTP ${response.status} ${JSON.stringify(body).slice(0, 90)}`);
    console.log(`     paid ${usd(payment!.record.amount)} from one-time account ${payment!.record.payer} (settle ${payment!.settlement?.transaction.slice(0, 18)}…)`);
  }
  console.log(`   shielded balance now: ${usd(wallet.balance())}`);

  step(4, "What each party can see");
  const payers = svc.merchantLedger.map((e) => getAddress(e.payer));
  console.log("   Merchant ledger (payer addresses):");
  for (const e of svc.merchantLedger) console.log(`     ${e.payer}  ${usd(e.amount)}  ${e.resource}`);
  const distinct = new Set(payers).size === payers.length;
  const linked = payers.some((p) => p === getAddress(funder.address));
  console.log(`   every payment from a different address: ${distinct}`);
  console.log(`   any payer equals the funding wallet: ${linked}`);
  for (const p of payers) {
    const nonce = await client.getTransactionCount({ address: p });
    const bal = await client.readContract({ address: d.token, abi: MockUSDC.abi, functionName: "balanceOf", args: [p] });
    console.log(`     ${p}: ${nonce} txs sent, ${usd(bal)} left (never paid gas, funded only by the pool)`);
  }

  const report = await auditWithViewingKey(keys.viewingKey, client, d);
  console.log("   Auditor with the viewing key only (cannot spend):");
  for (const e of report.entries) {
    const what = e.kind === "deposit" ? `from ${e.depositor}` : e.kind === "payment" ? `to ${e.payTo} for ${e.resource}` : `to ${e.to}`;
    console.log(`     ${e.kind.padEnd(8)} ${usd(e.amount).padEnd(14)} ${what}`);
  }
  console.log(`     totals: deposited ${usd(report.totals.deposited)}, paid ${usd(report.totals.paid)}, fees ${usd(report.totals.fees)}, balance ${usd(report.totals.shieldedBalance)}`);

  step(5, "Compliance: a screened address cannot deposit");
  const blocked = privateKeyToAccount(DEV_KEYS.blocked);
  try {
    await wallet.deposit(blocked, 1_000_000n);
    console.log("   UNEXPECTED: deposit from blocked address succeeded");
    process.exitCode = 1;
  } catch (err) {
    console.log(`   rejected: ${(err as Error).message}`);
  }

  if (!distinct || linked || wallet.balance() !== BigInt(report.totals.shieldedBalance)) process.exitCode = 1;
  console.log(process.exitCode ? "\nDEMO FAILED" : "\nDemo complete.");
  await svc.close();
  chain.stop();
  await shutdownProver();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

main().catch(async (err) => {
  console.error(err);
  await shutdownProver();
  process.exit(1);
});
