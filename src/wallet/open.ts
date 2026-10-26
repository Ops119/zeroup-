import fs from "fs";
import path from "path";
import type { Config } from "../config";
import { makePublicClient } from "../core/chain";
import { loadDeployment, type Deployment } from "../core/deployment";
import { keysFromMnemonic, newMnemonic } from "../core/keys";
import { readKeystore, writeKeystore } from "./keystore";
import { ZeroupWallet } from "./wallet";
import type { SpendPolicy } from "./policy";

export function keystorePath(cfg: Config): string {
  return path.join(cfg.dataDir, "keystore.json");
}

export function passphrase(cfg: Config): string {
  const p = process.env.ZEROUP_PASSPHRASE;
  if (p) return p;
  if (cfg.isLocal) return "zeroup-dev";
  throw new Error("set ZEROUP_PASSPHRASE to unlock the wallet keystore");
}

/** Creates a keystore if none exists (returns the new mnemonic so it can be backed up). */
export function ensureKeystore(cfg: Config, mnemonic?: string): string | null {
  const file = keystorePath(cfg);
  if (fs.existsSync(file)) return null;
  const m = mnemonic ?? newMnemonic();
  writeKeystore(file, m, passphrase(cfg));
  return m;
}

export async function openWallet(
  cfg: Config,
  opts: { deployment?: Deployment; sponsorUrl?: string; policy?: SpendPolicy; log?: (m: string) => void } = {},
): Promise<ZeroupWallet> {
  const deployment = opts.deployment ?? loadDeployment(cfg.network, cfg.deploymentFile);
  const keys = keysFromMnemonic(readKeystore(keystorePath(cfg), passphrase(cfg)));
  return ZeroupWallet.open({
    keys,
    deployment,
    publicClient: makePublicClient(cfg.rpcUrl, cfg.chainId),
    sponsorUrl: opts.sponsorUrl ?? cfg.urls.sponsor,
    stateFile: path.join(cfg.dataDir, `state-${deployment.network}-${deployment.pool.toLowerCase()}.bin`),
    policy: opts.policy,
    logChunkSize: cfg.logChunkSize,
    log: opts.log,
  });
}
