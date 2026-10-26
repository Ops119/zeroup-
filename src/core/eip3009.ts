import type { Hex } from "viem";

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
