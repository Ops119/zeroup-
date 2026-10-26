import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex, type Hex } from "viem";
import { poseidon } from "./poseidon";
import { toField } from "./field";

/**
 * Zeroup key engine. Every key comes from one root seed:
 *
 *   spendingKey  -> note nullifiers/secrets and one-time payer accounts (can move money)
 *   viewingKey   -> decrypts note memos and payment history (read-only, shareable with an auditor)
 *   stealth keys -> ERC-5564 meta-address for receiving privately
 */
export interface ZeroupKeys {
  spendingKey: Uint8Array;
  viewingKey: Uint8Array;
  stealthSpendingKey: Uint8Array;
  stealthViewingKey: Uint8Array;
}

const enc = new TextEncoder();

function derive(ikm: Uint8Array, label: string, index?: number): Uint8Array {
  const info = index === undefined ? `zeroup/v1/${label}` : `zeroup/v1/${label}/${index}`;
  return hkdf(sha256, ikm, enc.encode("zeroup"), enc.encode(info), 32);
}

export function newMnemonic(): string {
  return generateMnemonic(wordlist, 256);
}

export function keysFromMnemonic(mnemonic: string): ZeroupKeys {
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error("invalid mnemonic");
  return keysFromSeed(mnemonicToSeedSync(mnemonic));
}

export function keysFromSeed(seed: Uint8Array): ZeroupKeys {
  return {
    spendingKey: derive(seed, "spend"),
    viewingKey: derive(seed, "view"),
    stealthSpendingKey: secpKey(seed, "stealth-spend"),
    stealthViewingKey: secpKey(seed, "stealth-view"),
  };
}

export interface NoteSecrets {
  nullifier: bigint;
  secret: bigint;
  precommitment: bigint;
  nullifierHash: bigint;
}

/** Deterministic per-note secrets so a wallet can be fully recovered from its seed. */
export function noteSecrets(keys: ZeroupKeys, noteIndex: number): NoteSecrets {
  const nullifier = toField(derive(keys.spendingKey, "nullifier", noteIndex));
  const secret = toField(derive(keys.spendingKey, "secret", noteIndex));
  return {
    nullifier,
    secret,
    precommitment: poseidon([nullifier, secret]),
    nullifierHash: poseidon([nullifier]),
  };
}

/** Fresh one-time EOA that pays exactly one x402 invoice. */
export function payerPrivateKey(keys: ZeroupKeys, payerIndex: number): Hex {
  return bytesToHex(secpKey(keys.spendingKey, "payer", payerIndex));
}

function secpKey(ikm: Uint8Array, label: string, index?: number): Uint8Array {
  // Re-derive on the (astronomically unlikely) out-of-range result.
  for (let attempt = 0; ; attempt++) {
    const k = derive(ikm, attempt === 0 ? label : `${label}#${attempt}`, index);
    if (secp256k1.utils.isValidPrivateKey(k)) return k;
  }
}
