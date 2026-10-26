import fs from "fs";
import path from "path";
import type { Hex, PublicClient, WalletClient, Account, Chain, Transport } from "viem";
import { getAddress } from "viem";
import { ZeroupPool, MockUSDC, Screener, Groth16Verifier, PoseidonT3 } from "../generated/contracts";

export interface Deployment {
  network: string;
  chainId: number;
  token: Hex;
  tokenName: string;
  tokenVersion: string;
  tokenDecimals: number;
  pool: Hex;
  screener: Hex;
  verifier: Hex;
  poseidon: Hex;
  deployBlock: string;
  mockToken: boolean;
}

export const DEPLOYMENTS_DIR = path.join(__dirname, "..", "..", "deployments");

export function loadDeployment(network: string, file?: string): Deployment {
  const p = file ?? path.join(DEPLOYMENTS_DIR, `${network}.json`);
  if (!fs.existsSync(p)) throw new Error(`no deployment at ${p}; run "npm run deploy" first`);
  return JSON.parse(fs.readFileSync(p, "utf8")) as Deployment;
}

export function saveDeployment(d: Deployment, file?: string): string {
  const p = file ?? path.join(DEPLOYMENTS_DIR, `${d.network}.json`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(d, null, 2) + "\n");
  return p;
}

/** Substitutes library addresses into unlinked bytecode. */
export function linkBytecode(
  bytecode: Hex,
  linkReferences: Record<string, Record<string, { start: number; length: number }[]>>,
  libraries: Record<string, Hex>,
): Hex {
  let code = bytecode.slice(2);
  for (const libs of Object.values(linkReferences)) {
    for (const [name, refs] of Object.entries(libs)) {
      const addr = libraries[name];
      if (!addr) throw new Error(`missing library address for ${name}`);
      for (const { start, length } of refs) {
        code = code.slice(0, start * 2) + addr.slice(2).toLowerCase() + code.slice((start + length) * 2);
      }
    }
  }
  return `0x${code}`;
}

type Wallet = WalletClient<Transport, Chain, Account>;

async function deploy(wallet: Wallet, client: PublicClient, abi: readonly unknown[], bytecode: Hex, args: unknown[] = []): Promise<Hex> {
  const hash = await wallet.deployContract({ abi, bytecode, args } as never);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("deployment failed");
  return getAddress(receipt.contractAddress);
}

export interface DeployOptions {
  network: string;
  /** Existing EIP-3009 token (e.g. USDC). A MockUSDC is deployed when omitted. */
  token?: { address: Hex; name: string; version: string; decimals: number };
  screenerOwner?: Hex;
  log?: (msg: string) => void;
}

export async function deployZeroup(wallet: Wallet, client: PublicClient, opts: DeployOptions): Promise<Deployment> {
  const log = opts.log ?? (() => {});
  const startBlock = await client.getBlockNumber();

  let token = opts.token;
  if (!token) {
    const address = await deploy(wallet, client, MockUSDC.abi, MockUSDC.bytecode);
    log(`MockUSDC        ${address}`);
    token = { address, name: "USDC", version: "2", decimals: 6 };
  }
  const poseidon = await deploy(wallet, client, PoseidonT3.abi, PoseidonT3.bytecode);
  log(`PoseidonT3      ${poseidon}`);
  const verifier = await deploy(wallet, client, Groth16Verifier.abi, Groth16Verifier.bytecode);
  log(`Groth16Verifier ${verifier}`);
  const screener = await deploy(wallet, client, Screener.abi, Screener.bytecode, [opts.screenerOwner ?? wallet.account.address]);
  log(`Screener        ${screener}`);
  const poolCode = linkBytecode(ZeroupPool.bytecode, ZeroupPool.linkReferences, { PoseidonT3: poseidon });
  const pool = await deploy(wallet, client, ZeroupPool.abi, poolCode, [token.address, verifier, screener]);
  log(`ZeroupPool      ${pool}`);

  return {
    network: opts.network,
    chainId: await client.getChainId(),
    token: token.address,
    tokenName: token.name,
    tokenVersion: token.version,
    tokenDecimals: token.decimals,
    pool,
    screener,
    verifier,
    poseidon,
    deployBlock: startBlock.toString(),
    mockToken: !opts.token,
  };
}
