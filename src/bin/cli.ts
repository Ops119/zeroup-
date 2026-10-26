/**
 * zeroup CLI: an agent wallet on the command line.
 *
 *   zeroup init [--mnemonic "..."]      create an encrypted keystore
 *   zeroup status                        sync and show balance, notes, payments
 *   zeroup deposit <amount>              gasless deposit from FUNDER_PRIVATE_KEY
 *   zeroup pay <url> [--method POST] [--data JSON]
 *                                        call an x402 endpoint, paying privately
 *   zeroup exit <address> <amount>       withdraw to a public address
 *   zeroup reclaim                       return unsettled payment funds to the pool
 *   zeroup viewing-key                   print the read-only viewing key
 *   zeroup audit <viewingKey>            history visible to a viewing key
 *   zeroup meta-address                  ERC-5564 stealth meta-address
 */
import { hexToBytes, getAddress, parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig, requireKey } from "../config";
import { formatUnits6, makePublicClient } from "../core/chain";
import { loadDeployment } from "../core/deployment";
import { keysFromMnemonic } from "../core/keys";
import { shutdownProver } from "../core/prover";
import { stealthMetaAddress } from "../core/stealth";
import { auditWithViewingKey } from "../wallet/auditor";
import { readKeystore } from "../wallet/keystore";
import { ensureKeystore, keystorePath, openWallet, passphrase } from "../wallet/open";
import { createPrivateFetch } from "../wallet/x402-fetch";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args.shift();
  const cfg = loadConfig();
  const usd = (v: bigint | string) => `${formatUnits6(BigInt(v))} USDC`;

  switch (cmd) {
    case "init": {
      const m = ensureKeystore(cfg, flag(args, "mnemonic"));
      if (!m) throw new Error(`${keystorePath(cfg)} already exists`);
      console.log(`Created ${keystorePath(cfg)}.\nRecovery phrase (write it down, it is shown once):\n\n  ${m}\n`);
      return;
    }
    case "status": {
      const w = await openWallet(cfg);
      await w.sync();
      console.log(`network ${w.network}  pool ${w.deployment.pool}`);
      console.log(`shielded balance ${usd(w.balance())}`);
      for (const n of w.notes().filter((x) => !x.spent)) console.log(`  note #${n.noteIndex} leaf ${n.leafIndex}: ${usd(n.value)}`);
      for (const p of w.payments()) {
        console.log(`  ${new Date(p.ts).toISOString()} ${p.status.padEnd(6)} ${usd(p.amount)} -> ${p.payTo} via ${p.payer} ${p.resource}`);
      }
      return;
    }
    case "deposit": {
      const funder = privateKeyToAccount(requireKey(cfg.keys.funder, "FUNDER_PRIVATE_KEY"));
      const w = await openWallet(cfg, { log: console.log });
      const amount = parseUnits(requireArg(args[0], "amount"), w.deployment.tokenDecimals);
      const r = await w.deposit(funder, amount);
      console.log(`deposited ${usd(amount)} from ${funder.address} (tx ${r.txHash}); balance ${usd(w.balance())}`);
      return;
    }
    case "pay": {
      const method = flag(args, "method") ?? "GET";
      const data = flag(args, "data");
      const url = requireArg(args[0], "url");
      const w = await openWallet(cfg, { log: (m) => console.error(m) });
      const { response, payment } = await createPrivateFetch(w)(url, {
        method,
        body: data,
        headers: data ? { "content-type": "application/json" } : undefined,
      });
      if (payment) {
        console.error(`paid ${usd(payment.record.amount)} from ${payment.record.payer}; settlement ${payment.settlement?.success ? payment.settlement.transaction : "failed: " + payment.settlement?.errorReason}`);
      }
      console.error(`HTTP ${response.status}`);
      console.log(await response.text());
      return;
    }
    case "exit": {
      const to = getAddress(requireArg(args[0], "address"));
      const w = await openWallet(cfg, { log: console.log });
      const amount = parseUnits(requireArg(args[1], "amount"), w.deployment.tokenDecimals);
      const txs = await w.exit(to, amount);
      console.log(`sent ${usd(amount)} to ${to} (${txs.join(", ")}); balance ${usd(w.balance())}`);
      return;
    }
    case "reclaim": {
      const w = await openWallet(cfg, { log: console.log });
      const out = await w.reclaim();
      for (const r of out) console.log(`returned ${usd(r.amount)} from ${r.payer} (tx ${r.txHash})`);
      console.log(out.length ? `balance ${usd(w.balance())}` : "nothing to reclaim");
      return;
    }
    case "viewing-key": {
      const keys = keysFromMnemonic(readKeystore(keystorePath(cfg), passphrase(cfg)));
      console.log(`0x${Buffer.from(keys.viewingKey).toString("hex")}`);
      return;
    }
    case "audit": {
      const vk = requireArg(args[0], "viewingKey") as Hex;
      const d = loadDeployment(cfg.network, cfg.deploymentFile);
      const r = await auditWithViewingKey(hexToBytes(vk), makePublicClient(cfg.rpcUrl, cfg.chainId), d, cfg.logChunkSize);
      for (const e of r.entries) {
        const detail = e.kind === "deposit" ? `from ${e.depositor}` : e.kind === "payment" ? `to ${e.payTo} for ${e.resource}` : `to ${e.to}`;
        console.log(`${e.kind.padEnd(8)} ${usd(e.amount).padEnd(16)} ${detail}  (block ${e.block})`);
      }
      const t = r.totals;
      console.log(`deposited ${usd(t.deposited)}  paid ${usd(t.paid)}  exited ${usd(t.withdrawn)}  fees ${usd(t.fees)}  balance ${usd(t.shieldedBalance)}`);
      return;
    }
    case "meta-address": {
      const keys = keysFromMnemonic(readKeystore(keystorePath(cfg), passphrase(cfg)));
      console.log(stealthMetaAddress(keys.stealthSpendingKey, keys.stealthViewingKey).encoded);
      return;
    }
    default:
      console.log(require("fs").readFileSync(__filename, "utf8").split("*/")[0].replace(/^\/\*\*?|^ \* ?/gm, ""));
      process.exitCode = cmd ? 2 : 0;
  }
}

function requireArg(v: string | undefined, name: string): string {
  if (!v) throw new Error(`missing <${name}>`);
  return v;
}

main()
  .catch((err) => {
    console.error(`error: ${err.message ?? err}`);
    process.exitCode = 1;
  })
  .finally(() => shutdownProver());
