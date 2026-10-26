import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { randomBytes } from "crypto";
import { bytesToHex, hexToBytes, type Hex } from "viem";

/**
 * Note memos ride on-chain with each deposit/withdrawal, encrypted to the
 * owner's viewing key. They let a wallet recover itself from the seed and let
 * an auditor holding only the viewing key read history without spending power.
 * Plaintexts are padded to 128-byte buckets so lengths leak little.
 */
const BUCKET = 128;
const MEMO_VERSION = 1;

export type Memo =
  | { v: 1; kind: "deposit"; noteIndex: number; value: string; ts: number }
  | {
      v: 1;
      kind: "payment";
      noteIndex: number;
      value: string;
      spentNoteIndex: number;
      payer: Hex;
      payerIndex: number;
      payTo: Hex;
      amount: string;
      fee: string;
      resource: string;
      ts: number;
    }
  | { v: 1; kind: "withdraw"; noteIndex: number; value: string; spentNoteIndex: number; to: Hex; amount: string; fee: string; ts: number };

export function encryptMemo(viewingKey: Uint8Array, memo: Memo): Hex {
  const json = new TextEncoder().encode(JSON.stringify(memo));
  const padded = new Uint8Array(Math.ceil((json.length + 2) / BUCKET) * BUCKET);
  padded[0] = json.length >> 8;
  padded[1] = json.length & 0xff;
  padded.set(json, 2);
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(viewingKey, nonce).encrypt(padded);
  return bytesToHex(new Uint8Array([MEMO_VERSION, ...nonce, ...ct]));
}

export function decryptMemo(viewingKey: Uint8Array, data: Hex): Memo | null {
  try {
    const bytes = hexToBytes(data);
    if (bytes.length < 1 + 24 + 16 || bytes[0] !== MEMO_VERSION) return null;
    const padded = xchacha20poly1305(viewingKey, bytes.slice(1, 25)).decrypt(bytes.slice(25));
    const len = (padded[0] << 8) | padded[1];
    return JSON.parse(new TextDecoder().decode(padded.slice(2, 2 + len))) as Memo;
  } catch {
    return null;
  }
}
