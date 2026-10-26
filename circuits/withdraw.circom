pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/mux1.circom";

// Recomputes a Merkle root from a leaf and its authentication path.
template MerkleRoot(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal output root;

    component hashers[levels];
    component muxes[levels];
    signal levelHashes[levels + 1];
    levelHashes[0] <== leaf;

    for (var i = 0; i < levels; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        muxes[i] = MultiMux1(2);
        muxes[i].c[0][0] <== levelHashes[i];
        muxes[i].c[0][1] <== pathElements[i];
        muxes[i].c[1][0] <== pathElements[i];
        muxes[i].c[1][1] <== levelHashes[i];
        muxes[i].s <== pathIndices[i];

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== muxes[i].out[0];
        hashers[i].inputs[1] <== muxes[i].out[1];
        levelHashes[i + 1] <== hashers[i].out;
    }

    root <== levelHashes[levels];
}

// Spends one shielded note, releases `withdrawnValue` publicly and re-commits
// the remainder as a fresh note.
//
//   precommitment = Poseidon(nullifier, secret)
//   commitment    = Poseidon(value, precommitment)   (computed on-chain at deposit)
//   nullifierHash = Poseidon(nullifier)
//
// `context` binds the proof to recipient, relayer, fee and encrypted memo so a
// relayer cannot redirect funds.
template Withdraw(levels) {
    signal input root;
    signal input nullifierHash;
    signal input withdrawnValue;
    signal input newCommitment;
    signal input context;

    signal input value;
    signal input nullifier;
    signal input secret;
    signal input newNullifier;
    signal input newSecret;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    component pre = Poseidon(2);
    pre.inputs[0] <== nullifier;
    pre.inputs[1] <== secret;

    component commitment = Poseidon(2);
    commitment.inputs[0] <== value;
    commitment.inputs[1] <== pre.out;

    component nh = Poseidon(1);
    nh.inputs[0] <== nullifier;
    nh.out === nullifierHash;

    component tree = MerkleRoot(levels);
    tree.leaf <== commitment.out;
    for (var i = 0; i < levels; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }
    tree.root === root;

    // Range checks stop field wrap-around: withdrawnValue <= value.
    signal remaining;
    remaining <== value - withdrawnValue;
    component remainingBits = Num2Bits(128);
    remainingBits.in <== remaining;
    component withdrawnBits = Num2Bits(128);
    withdrawnBits.in <== withdrawnValue;

    component newPre = Poseidon(2);
    newPre.inputs[0] <== newNullifier;
    newPre.inputs[1] <== newSecret;
    component newC = Poseidon(2);
    newC.inputs[0] <== remaining;
    newC.inputs[1] <== newPre.out;
    newC.out === newCommitment;

    signal contextSquare;
    contextSquare <== context * context;
}

component main {public [root, nullifierHash, withdrawnValue, newCommitment, context]} = Withdraw(20);
