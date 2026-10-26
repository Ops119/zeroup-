// circomlibjs ships without type declarations.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildPoseidon } = require("circomlibjs");

type PoseidonFn = ((inputs: bigint[]) => unknown) & { F: { toObject(x: unknown): bigint } };

let instance: PoseidonFn | undefined;

/** Must be awaited once before calling `poseidon`. */
export async function initPoseidon(): Promise<void> {
  if (!instance) instance = (await buildPoseidon()) as PoseidonFn;
}

/** circomlib-compatible Poseidon, identical to the circuit and PoseidonT3.sol. */
export function poseidon(inputs: bigint[]): bigint {
  if (!instance) throw new Error("call initPoseidon() first");
  return instance.F.toObject(instance(inputs));
}
