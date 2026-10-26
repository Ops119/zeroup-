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
  status: "funded" | "paid" | "failed";
  error?: string;
}

export interface WalletState {
  version: 1;
  chainId: number;
  pool: string;
  lastSyncedBlock: string;
  leaves: string[];
  notes: NoteRecord[];
  payments: PaymentRecord[];
  nextNoteIndex: number;
  nextPayerIndex: number;
}

export function emptyState(chainId: number, pool: string, fromBlock: bigint): WalletState {
  return {
    version: 1,
    chainId,
    pool,
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

  load(): WalletState | null {
    if (!fs.existsSync(this.file)) return null;
    const raw = fs.readFileSync(this.file);
    const pt = xchacha20poly1305(this.key, raw.subarray(0, 24)).decrypt(raw.subarray(24));
    return JSON.parse(new TextDecoder().decode(pt)) as WalletState;
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
