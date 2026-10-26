import { randomBytes } from "crypto";

/** BN254 scalar field order: every circuit signal lives in this field. */
export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export function bytesToBigInt(bytes: Uint8Array): bigint {
  return BigInt("0x" + Buffer.from(bytes).toString("hex"));
}

/** Uniform-enough field element (64 random bytes reduced, bias < 2^-250). */
export function randomFieldElement(): bigint {
  return bytesToBigInt(randomBytes(64)) % FIELD;
}

export function toField(bytes: Uint8Array): bigint {
  return bytesToBigInt(bytes) % FIELD;
}
