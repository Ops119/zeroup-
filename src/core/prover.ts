import path from "path";
import fs from "fs";
// snarkjs ships without type declarations.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const snarkjs = require("snarkjs");

const ZK_DIR = process.env.ZEROUP_ZK_DIR ?? path.join(__dirname, "..", "..", "zk");
const WASM = path.join(ZK_DIR, "withdraw.wasm");
const ZKEY = path.join(ZK_DIR, "withdraw.zkey");
const VKEY = path.join(ZK_DIR, "withdraw_vkey.json");

/** Groth16 proof in the layout ZeroupPool.withdraw expects. */
export interface SolidityProof {
  a: [string, string];
  b: [[string, string], [string, string]];
  c: [string, string];
}

export interface WithdrawWitness {
  root: bigint;
  nullifierHash: bigint;
  withdrawnValue: bigint;
  newCommitment: bigint;
  context: bigint;
  value: bigint;
  nullifier: bigint;
  secret: bigint;
  newNullifier: bigint;
  newSecret: bigint;
  pathElements: bigint[];
  pathIndices: number[];
}

/** Public signals, in circuit order. */
export function publicSignals(w: Pick<WithdrawWitness, "root" | "nullifierHash" | "withdrawnValue" | "newCommitment" | "context">): bigint[] {
  return [w.root, w.nullifierHash, w.withdrawnValue, w.newCommitment, w.context];
}

export async function proveWithdraw(w: WithdrawWitness): Promise<SolidityProof> {
  const input = {
    root: w.root.toString(),
    nullifierHash: w.nullifierHash.toString(),
    withdrawnValue: w.withdrawnValue.toString(),
    newCommitment: w.newCommitment.toString(),
    context: w.context.toString(),
    value: w.value.toString(),
    nullifier: w.nullifier.toString(),
    secret: w.secret.toString(),
    newNullifier: w.newNullifier.toString(),
    newSecret: w.newSecret.toString(),
    pathElements: w.pathElements.map(String),
    pathIndices: w.pathIndices.map(String),
  };
  const { proof } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
  return {
    a: [proof.pi_a[0], proof.pi_a[1]],
    // G2 coordinates are swapped for the EVM pairing precompile.
    b: [
      [proof.pi_b[0][1], proof.pi_b[0][0]],
      [proof.pi_b[1][1], proof.pi_b[1][0]],
    ],
    c: [proof.pi_c[0], proof.pi_c[1]],
  };
}

let vkey: unknown;

/** Off-chain check so a sponsor never spends gas on an invalid proof. */
export async function verifyWithdrawProof(proof: SolidityProof, signals: bigint[]): Promise<boolean> {
  vkey ??= JSON.parse(fs.readFileSync(VKEY, "utf8"));
  const p = {
    protocol: "groth16",
    curve: "bn128",
    pi_a: [proof.a[0], proof.a[1], "1"],
    pi_b: [
      [proof.b[0][1], proof.b[0][0]],
      [proof.b[1][1], proof.b[1][0]],
      ["1", "0"],
    ],
    pi_c: [proof.c[0], proof.c[1], "1"],
  };
  try {
    return await snarkjs.groth16.verify(vkey, signals.map(String), p);
  } catch {
    return false;
  }
}

/** snarkjs keeps worker threads alive; call before a CLI process exits. */
export async function shutdownProver(): Promise<void> {
  const curve = (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128;
  if (curve) await curve.terminate();
}
