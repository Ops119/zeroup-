/**
 * Production entrypoint: runs one service against the configured network.
 *   zeroup-serve sponsor | facilitator | merchant | wallet
 */
import { privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";
import { loadConfig, requireKey } from "../config";
import { makePublicClient, makeWalletClient } from "../core/chain";
import { loadDeployment } from "../core/deployment";
import { keysFromMnemonic } from "../core/keys";
import { caip2 } from "../core/x402";
import { createSponsorApp } from "../services/sponsor";
import { createFacilitatorApp } from "../services/facilitator";
import { createMerchantApp } from "../services/merchant";
import { createWalletServer } from "../services/wallet-server";
import { listen } from "../services/http";
import { keystorePath, openWallet, passphrase } from "../wallet/open";
import { readKeystore } from "../wallet/keystore";

async function main() {
  const which = process.argv[2];
  const cfg = loadConfig();
  const d = loadDeployment(cfg.network, cfg.deploymentFile);
  const client = makePublicClient(cfg.rpcUrl, cfg.chainId);
  const host = process.env.HOST ?? "127.0.0.1";
  const log = (m: string) => console.log(`[${which}] ${m}`);
  if ((await client.getChainId()) !== d.chainId) throw new Error("RPC chain id does not match deployment");

  switch (which) {
    case "sponsor": {
      const wallet = makeWalletClient(cfg.rpcUrl, cfg.chainId, requireKey(cfg.keys.sponsor, "SPONSOR_PRIVATE_KEY"));
      await listen(createSponsorApp({ deployment: d, publicClient: client, wallet, withdrawFee: cfg.sponsorWithdrawFee, minDeposit: cfg.sponsorMinDeposit, log }), cfg.ports.sponsor, host);
      log(`listening on ${host}:${cfg.ports.sponsor} as ${wallet.account.address}`);
      break;
    }
    case "facilitator": {
      const wallet = makeWalletClient(cfg.rpcUrl, cfg.chainId, requireKey(cfg.keys.facilitator, "FACILITATOR_PRIVATE_KEY"));
      await listen(createFacilitatorApp({ deployment: d, publicClient: client, wallet, apiKey: cfg.facilitatorApiKey, log }), cfg.ports.facilitator, host);
      log(`listening on ${host}:${cfg.ports.facilitator} as ${wallet.account.address}`);
      break;
    }
    case "merchant": {
      if (!cfg.merchantPayTo) throw new Error("MERCHANT_PAY_TO is not set");
      const { app } = createMerchantApp({
        facilitatorUrl: cfg.urls.facilitator,
        network: caip2(d.chainId),
        asset: d.token,
        assetName: d.tokenName,
        assetVersion: d.tokenVersion,
        payTo: getAddress(cfg.merchantPayTo),
        facilitatorApiKey: cfg.facilitatorApiKey,
      });
      await listen(app, cfg.ports.merchant, host);
      log(`listening on ${host}:${cfg.ports.merchant}, paying to ${cfg.merchantPayTo}`);
      break;
    }
    case "wallet": {
      const walletHost = process.env.WALLET_HOST ?? "127.0.0.1";
      const loopback = ["127.0.0.1", "localhost", "::1"].includes(walletHost);
      if (!loopback && !process.env.WALLET_API_TOKEN) {
        throw new Error("refusing to expose the wallet API beyond localhost without WALLET_API_TOKEN");
      }
      const keys = keysFromMnemonic(readKeystore(keystorePath(cfg), passphrase(cfg)));
      const wallet = await openWallet(cfg, { deployment: d, log });
      const app = createWalletServer({
        wallet,
        keys,
        publicClient: client,
        funder: cfg.keys.funder ? privateKeyToAccount(cfg.keys.funder) : undefined,
        apiToken: process.env.WALLET_API_TOKEN,
        merchantUrl: process.env.MERCHANT_URL,
        allowedHosts: process.env.WALLET_ALLOWED_HOSTS?.split(",").map((h) => h.trim().toLowerCase()),
        log,
      });
      await listen(app, cfg.ports.wallet, walletHost);
      log(`dashboard on http://127.0.0.1:${cfg.ports.wallet}`);
      break;
    }
    default:
      console.error("usage: serve <sponsor|facilitator|merchant|wallet>");
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
