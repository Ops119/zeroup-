import { poseidon } from "./poseidon";

export interface MerklePath {
  pathElements: bigint[];
  pathIndices: number[];
}

/**
 * Off-chain mirror of ZeroupPool's incremental Poseidon tree. Leaves are
 * appended in on-chain leafIndex order, so the root always matches a root the
 * contract has seen.
 */
export class MerkleTree {
  readonly zeros: bigint[] = [];
  private readonly layers: Map<number, bigint>[] = [];

  constructor(readonly levels: number) {
    let z = 0n;
    for (let i = 0; i <= levels; i++) {
      this.zeros.push(z);
      this.layers.push(new Map());
      z = poseidon([z, z]);
    }
  }

  get size(): number {
    return this.layers[0].size;
  }

  insert(leaf: bigint): number {
    const index = this.size;
    if (index >= 2 ** this.levels) throw new Error("tree full");
    this.layers[0].set(index, leaf);
    let cur = index;
    for (let level = 0; level < this.levels; level++) {
      const parent = cur >> 1;
      const left = this.node(level, parent * 2);
      const right = this.node(level, parent * 2 + 1);
      this.layers[level + 1].set(parent, poseidon([left, right]));
      cur = parent;
    }
    return index;
  }

  root(): bigint {
    return this.node(this.levels, 0);
  }

  leaf(index: number): bigint | undefined {
    return this.layers[0].get(index);
  }

  path(index: number): MerklePath {
    if (index >= this.size) throw new Error(`leaf ${index} not in tree`);
    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];
    let cur = index;
    for (let level = 0; level < this.levels; level++) {
      pathIndices.push(cur & 1);
      pathElements.push(this.node(level, cur ^ 1));
      cur >>= 1;
    }
    return { pathElements, pathIndices };
  }

  private node(level: number, index: number): bigint {
    return this.layers[level].get(index) ?? this.zeros[level];
  }
}
