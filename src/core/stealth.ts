import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak256, bytesToHex, hexToBytes, type Hex, getAddress } from "viem";
import { randomBytes } from "crypto";

/**
 * ERC-5564 scheme 1 (secp256k1 with view tags). A merchant or person publishes
 * a stealth meta-address; each payer derives a fresh address only the
 * recipient can find and spend from.
 */
const N = secp256k1.CURVE.n;

export interface StealthMetaAddress {
  spendingPublicKey: Hex;
  viewingPublicKey: Hex;
  /** st:eth:0x<spendPub><viewPub> */
  encoded: string;
}

export function stealthMetaAddress(spendingKey: Uint8Array, viewingKey: Uint8Array): StealthMetaAddress {
  const spendingPublicKey = bytesToHex(secp256k1.getPublicKey(spendingKey, true));
  const viewingPublicKey = bytesToHex(secp256k1.getPublicKey(viewingKey, true));
  return {
    spendingPublicKey,
    viewingPublicKey,
    encoded: `st:eth:0x${spendingPublicKey.slice(2)}${viewingPublicKey.slice(2)}`,
  };
}

export function parseMetaAddress(encoded: string): { spendingPublicKey: Hex; viewingPublicKey: Hex } {
  const m = /^st:eth:0x([0-9a-fA-F]{66})([0-9a-fA-F]{66})$/.exec(encoded);
  if (!m) throw new Error("invalid stealth meta-address");
  return { spendingPublicKey: `0x${m[1]}`, viewingPublicKey: `0x${m[2]}` };
}

function pubToAddress(pub: Uint8Array): Hex {
  const uncompressed = secp256k1.ProjectivePoint.fromHex(pub).toRawBytes(false);
  return getAddress(`0x${keccak256(uncompressed.slice(1)).slice(-40)}`);
}

export interface GeneratedStealthAddress {
  stealthAddress: Hex;
  ephemeralPublicKey: Hex;
  viewTag: number;
}

export function generateStealthAddress(metaAddress: string, ephemeralKey: Uint8Array = randomBytes(32)): GeneratedStealthAddress {
  const { spendingPublicKey, viewingPublicKey } = parseMetaAddress(metaAddress);
  const shared = secp256k1.getSharedSecret(ephemeralKey, hexToBytes(viewingPublicKey), true);
  const hashedSecret = keccak256(shared.slice(1));
  const viewTag = hexToBytes(hashedSecret)[0];
  const s = BigInt(hashedSecret) % N;
  const stealthPoint = secp256k1.ProjectivePoint.fromHex(hexToBytes(spendingPublicKey)).add(
    secp256k1.ProjectivePoint.BASE.multiply(s),
  );
  return {
    stealthAddress: pubToAddress(stealthPoint.toRawBytes(true)),
    ephemeralPublicKey: bytesToHex(secp256k1.getPublicKey(ephemeralKey, true)),
    viewTag,
  };
}

/** Recipient side: returns the stealth private key if the announcement is ours. */
export function checkStealthAddress(
  announcement: { stealthAddress: Hex; ephemeralPublicKey: Hex; viewTag: number },
  spendingKey: Uint8Array,
  viewingKey: Uint8Array,
): Hex | null {
  const shared = secp256k1.getSharedSecret(viewingKey, hexToBytes(announcement.ephemeralPublicKey), true);
  const hashedSecret = keccak256(shared.slice(1));
  if (hexToBytes(hashedSecret)[0] !== announcement.viewTag) return null;
  const s = BigInt(hashedSecret) % N;
  const priv = (BigInt(bytesToHex(spendingKey)) + s) % N;
  const privHex = `0x${priv.toString(16).padStart(64, "0")}` as Hex;
  const address = pubToAddress(secp256k1.getPublicKey(hexToBytes(privHex), true));
  return address === getAddress(announcement.stealthAddress) ? privHex : null;
}
