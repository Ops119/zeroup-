/**
 * Local development stack: Hardhat chain, contracts, sponsor, facilitator,
 * demo paid API and the wallet dashboard, all in one process.
 */
import { privateKeyToAccount } from "viem/accounts";
import { DEV_KEYS, loadConfig } from "../config";
import { makePublicClient } from "../core/chain";
import { keysFromMnemonic } from "../core/keys";
import { saveDeployment } from "../core/deployment";
import { deployLocal, startLocalChain, startServices } from "../stack";
import { createWalletServer } from "../services/wallet-server";
import { listen } from "../services/http";
import { ensureKeystore, keystorePath, openWallet, passphrase } from "../wallet/open";
import { readKeystore } from "../wallet/keystore";

async function main() {
  const cfg = loadConfig();
  if (!cfg.isLocal) throw new Error("npm run dev only runs against a local chain (ZEROUP_NETWORK=localhost)");
  const chain = await startLocalChain(cfg.rpcUrl);
  console.log(chain.reused ? `using chain at ${cfg.rpcUrl}` : `started Hardhat node at ${cfg.rpcUrl}`);

  const d = await deployLocal(cfg, (m) => console.log(`  ${m}`));
  saveDeployment(d);
  const svc = await startServices(cfg, d, { log: (s, m) => console.log(`[${s}] ${m}`) });

  const mnemonic = ensureKeystore(cfg);
  if (mnemonic) console.log(`\nCreated dev wallet ${keystorePath(cfg)}\n  recovery phrase: ${mnemonic}\n`);
  const keys = keysFromMnemonic(readKeystore(keystorePath(cfg), passphrase(cfg)));
  const wallet = await openWallet(cfg, { deployment: d, sponsorUrl: svc.sponsorUrl, log: (m) => console.log(`[wallet] ${m}`) });
  const app = createWalletServer({
    wallet,
    keys,
    publicClient: makePublicClient(cfg.rpcUrl, cfg.chainId),
    funder: privateKeyToAccount(cfg.keys.funder ?? DEV_KEYS.funder),
    apiToken: process.env.WALLET_API_TOKEN,
    merchantUrl: svc.merchantUrl,
    log: (m) => console.log(`[wallet] ${m}`),
  });
  await listen(app, cfg.ports.wallet);

  console.log(`
Zeroup dev stack is running
  Dashboard       http://127.0.0.1:${cfg.ports.wallet}
  Paid API        ${svc.merchantUrl}
  Facilitator     ${svc.facilitatorUrl}   (GET /supported, POST /verify, POST /settle)
  Sponsor         ${svc.sponsorUrl}   (GET /v1/info)
  Chain           ${cfg.rpcUrl} (chainId ${d.chainId})
Ctrl+C to stop.`);

  const stop = async () => {
    await svc.close();
    chain.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
