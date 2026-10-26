import "dotenv/config";
import type { Hex } from "viem";

/**
 * Well-known Hardhat dev keys (mnemonic "test test ... junk"). Used only when
 * ZEROUP_NETWORK=localhost and no key is configured. Never fund these on a
 * real network.
 */
export const DEV_KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  sponsor: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  facilitator: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  funder: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  merchant: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  blocked: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
} as const satisfies Record<string, Hex>;

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

export interface Config {
  network: string;
  rpcUrl: string;
  chainId: number;
  isLocal: boolean;
  deploymentFile?: string;
  dataDir: string;
  keys: { deployer?: Hex; sponsor?: Hex; facilitator?: Hex; funder?: Hex };
  merchantPayTo?: Hex;
  ports: { sponsor: number; facilitator: number; merchant: number; wallet: number };
  urls: { sponsor: string; facilitator: string; merchant: string };
  sponsorWithdrawFee: bigint;
  sponsorMinDeposit: bigint;
  /** Shared secret between merchants and the facilitator (optional). */
  facilitatorApiKey?: string;
  logChunkSize: bigint;
}

export function loadConfig(): Config {
  const network = env("ZEROUP_NETWORK") ?? "localhost";
  const isLocal = network === "localhost";
  const key = (name: string, dev?: Hex): Hex | undefined => (env(name) as Hex | undefined) ?? (isLocal ? dev : undefined);
  const port = (name: string, d: number) => Number(env(name) ?? d);
  const ports = {
    sponsor: port("SPONSOR_PORT", 4010),
    facilitator: port("FACILITATOR_PORT", 4020),
    merchant: port("MERCHANT_PORT", 4030),
    wallet: port("WALLET_PORT", 4040),
  };
  return {
    network,
    rpcUrl: env("RPC_URL") ?? "http://127.0.0.1:8545",
    chainId: Number(env("CHAIN_ID") ?? (isLocal ? 31337 : 84532)),
    isLocal,
    deploymentFile: env("DEPLOYMENT_FILE"),
    dataDir: env("ZEROUP_DATA_DIR") ?? "data",
    keys: {
      deployer: key("DEPLOYER_PRIVATE_KEY", DEV_KEYS.deployer),
      sponsor: key("SPONSOR_PRIVATE_KEY", DEV_KEYS.sponsor),
      facilitator: key("FACILITATOR_PRIVATE_KEY", DEV_KEYS.facilitator),
      funder: key("FUNDER_PRIVATE_KEY", DEV_KEYS.funder),
    },
    merchantPayTo: env("MERCHANT_PAY_TO") as Hex | undefined,
    ports,
    urls: {
      sponsor: env("SPONSOR_URL") ?? `http://127.0.0.1:${ports.sponsor}`,
      facilitator: env("FACILITATOR_URL") ?? `http://127.0.0.1:${ports.facilitator}`,
      merchant: env("MERCHANT_URL") ?? `http://127.0.0.1:${ports.merchant}`,
    },
    sponsorWithdrawFee: BigInt(env("SPONSOR_WITHDRAW_FEE") ?? "2000"),
    sponsorMinDeposit: BigInt(env("SPONSOR_MIN_DEPOSIT") ?? "10000"),
    facilitatorApiKey: env("FACILITATOR_API_KEY"),
    logChunkSize: BigInt(env("LOG_CHUNK_SIZE") ?? "5000"),
  };
}

export function requireKey(k: Hex | undefined, name: string): Hex {
  if (!k) throw new Error(`${name} is not set`);
  return k;
}
