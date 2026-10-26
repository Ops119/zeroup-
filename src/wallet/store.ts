import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";

export interface NoteRecord {
  noteIndex: number;
  leafIndex: number;
  value: string;
  commitment: string;
  nullifierHash: string;
  spent: boolean;
  source: "deposit" | "change";
  createdAt: number;
}

export interface PaymentRecord {
  id: string;
  ts: number;
  resource: string;
  network: string;
  payTo: string;
  amount: string;
  fee: string;
  payer: string;
  payerIndex: number;
  withdrawTxs: string[];
  settleTx?: string;
  /** Unix seconds after which the signed EIP-3009 authorization can no longer settle. */
  authValidBefore?: number;
  /** funded: payer funded, awaiting settlement; reclaimed: unsettled funds moved back into the pool. */
  status: "funded" | "paid" | "failed" | "reclaimed";
  error?: string;
}

export interface WalletState {
  version: 1;
  chainId: number;
  pool: string;
  /** Hash of the pool's deployment block; a mismatch means a different chain (e.g. a reset dev node). */
  anchor?: string;
  lastSyncedBlock: string;
  leaves: string[];
  notes: NoteRecord[];
  payments: PaymentRecord[];
  nextNoteIndex: number;
  nextPayerIndex: number;
}

export function emptyState(chainId: number, pool: string, fromBlock: bigint, anchor?: string): WalletState {
  return {
    version: 1,
    chainId,
    pool,
    anchor,
    lastSyncedBlock: (fromBlock - 1n).toString(),
    leaves: [],
    notes: [],
    payments: [],
    nextNoteIndex: 0,
    nextPayerIndex: 0,
  };
}

/** Wallet state at rest, encrypted with a key derived from the viewing key. */
export class StateStore {
  private readonly key: Uint8Array;

  constructor(readonly file: string, viewingKey: Uint8Array) {
    this.key = hkdf(sha256, viewingKey, new TextEncoder().encode("zeroup"), new TextEncoder().encode("zeroup/v1/state"), 32);
  }

  /**
   * Returns null when there is no usable state. A corrupt or foreign file is
   * moved aside rather than fatal: state is a cache that the wallet rebuilds
   * from the chain and its seed.
   */
  load(): WalletState | null {
    if (!fs.existsSync(this.file)) return null;
    try {
      const raw = fs.readFileSync(this.file);
      const pt = xchacha20poly1305(this.key, raw.subarray(0, 24)).decrypt(raw.subarray(24));
      return JSON.parse(new TextDecoder().decode(pt)) as WalletState;
    } catch {
      fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      return null;
    }
  }

  save(state: WalletState): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const nonce = randomBytes(24);
    const ct = xchacha20poly1305(this.key, nonce).encrypt(new TextEncoder().encode(JSON.stringify(state)));
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, Buffer.concat([nonce, Buffer.from(ct)]), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
