/**
 * Deploys Zeroup contracts.
 *   localhost: MockUSDC + pool, demo funds and screening entry
 *   other networks: pool against an existing EIP-3009 token (TOKEN_ADDRESS)
 */
import { getAddress, type Hex } from "viem";
import { loadConfig, requireKey } from "../config";
import { makePublicClient, makeWalletClient } from "../core/chain";
import { deployZeroup, saveDeployment } from "../core/deployment";
import { deployLocal } from "../stack";

/** Native USDC (supports EIP-3009, domain "USDC"/"2"). */
const USDC: Record<number, Hex> = {
  84532: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base
};

async function main() {
  const cfg = loadConfig();
  const log = (m: string) => console.log(`  ${m}`);
  if (cfg.isLocal) {
    const client = makePublicClient(cfg.rpcUrl, cfg.chainId);
    await client.getChainId().catch(() => {
      throw new Error(`no node at ${cfg.rpcUrl}; start one with "npm run node"`);
    });
    const d = await deployLocal(cfg, log);
    console.log(`wrote ${saveDeployment(d, cfg.deploymentFile)}`);
    process.exit(0);
  }
  const client = makePublicClient(cfg.rpcUrl, cfg.chainId);
  const deployer = makeWalletClient(cfg.rpcUrl, cfg.chainId, requireKey(cfg.keys.deployer, "DEPLOYER_PRIVATE_KEY"));
  const tokenAddress = process.env.TOKEN_ADDRESS ?? USDC[cfg.chainId];
  if (!tokenAddress) throw new Error("TOKEN_ADDRESS is required on this network");
  const d = await deployZeroup(deployer, client, {
    network: cfg.network,
    token: {
      address: getAddress(tokenAddress),
      name: process.env.TOKEN_EIP712_NAME ?? "USDC",
      version: process.env.TOKEN_EIP712_VERSION ?? "2",
      decimals: Number(process.env.TOKEN_DECIMALS ?? 6),
    },
    screenerOwner: process.env.SCREENER_OWNER as Hex | undefined,
    log,
  });
  console.log(`wrote ${saveDeployment(d, cfg.deploymentFile)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
