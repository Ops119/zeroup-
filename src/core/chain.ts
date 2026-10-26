import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

export type Wallet = WalletClient<Transport, Chain, Account>;

export function chainFor(chainId: number, rpcUrl: string): Chain {
  if (chainId === base.id) return base;
  if (chainId === baseSepolia.id) return baseSepolia;
  return defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export function makePublicClient(rpcUrl: string, chainId: number): PublicClient {
  return createPublicClient({ chain: chainFor(chainId, rpcUrl), transport: http(rpcUrl), pollingInterval: 250 }) as PublicClient;
}

export function makeWalletClient(rpcUrl: string, chainId: number, privateKey: Hex): Wallet {
  return createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain: chainFor(chainId, rpcUrl),
    transport: http(rpcUrl),
  });
}

/** Serialises async jobs, e.g. transactions from one sender to keep nonces in order. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export function formatUnits6(value: bigint, decimals = 6): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${v / base}${frac ? "." + frac : ""}`;
}
