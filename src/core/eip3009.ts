import { compactSignatureToSignature, parseCompactSignature, parseSignature, type Hex } from "viem";

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: TRANSFER_WITH_AUTHORIZATION_TYPES.TransferWithAuthorization,
} as const;

export function tokenDomain(name: string, version: string, chainId: number, verifyingContract: Hex) {
  return { name, version, chainId, verifyingContract } as const;
}

/**
 * Splits a 65-byte or 64-byte (EIP-2098 compact) ECDSA signature into the
 * v/r/s form that USDC's EIP-3009 functions take.
 */
export function splitSignature(signature: Hex): { v: number; r: Hex; s: Hex } {
  const parsed =
    signature.length === 2 + 128
      ? compactSignatureToSignature(parseCompactSignature(signature))
      : parseSignature(signature);
  const v = parsed.v ?? BigInt(parsed.yParity! + 27);
  return { v: Number(v < 27n ? v + 27n : v), r: parsed.r, s: parsed.s };
}
