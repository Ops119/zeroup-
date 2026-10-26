#!/usr/bin/env bash
# Compiles the withdraw circuit and produces the Groth16 proving/verifying keys.
#
# Phase 1 uses the public Hermez Powers of Tau (a multi-party ceremony) when it
# can be downloaded, otherwise a local single-party phase 1 (dev only).
# Phase 2 here is a single local contribution: fine for development and
# testnets, NOT for mainnet. Run a multi-party phase-2 ceremony before
# mainnet (see docs/SECURITY.md).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=circuits/build
PTAU_POWER=14
PTAU=$OUT/powersOfTau28_hez_final_${PTAU_POWER}.ptau
PTAU_URL=https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_${PTAU_POWER}.ptau
entropy() { node -e "process.stdout.write(require('crypto').randomBytes(64).toString('hex'))"; }
mkdir -p "$OUT"

npx circom2 circuits/withdraw.circom --r1cs --wasm -o "$OUT"
npx snarkjs r1cs info "$OUT/withdraw.r1cs"

LOCAL_PTAU=$OUT/pot${PTAU_POWER}_local.ptau
if [ ! -f "$PTAU" ] && [ -f "$LOCAL_PTAU" ]; then
  PTAU=$LOCAL_PTAU
elif [ ! -f "$PTAU" ]; then
  if ! curl -fsL --retry 3 -o "$PTAU" "$PTAU_URL"; then
    rm -f "$PTAU"
    PTAU=$LOCAL_PTAU
    echo "Could not download the Hermez ptau; generating a local phase-1 (dev only)."
    npx snarkjs powersoftau new bn128 $PTAU_POWER "$OUT/pot_0000.ptau"
    npx snarkjs powersoftau contribute "$OUT/pot_0000.ptau" "$OUT/pot_0001.ptau" --name="zeroup-dev" -e="$(entropy)"
    npx snarkjs powersoftau prepare phase2 "$OUT/pot_0001.ptau" "$PTAU"
    rm -f "$OUT/pot_0000.ptau" "$OUT/pot_0001.ptau"
  fi
fi
echo "using phase-1 file $PTAU"

npx snarkjs groth16 setup "$OUT/withdraw.r1cs" "$PTAU" "$OUT/withdraw_0000.zkey"
npx snarkjs zkey contribute "$OUT/withdraw_0000.zkey" "$OUT/withdraw.zkey" --name="zeroup-dev" -e="$(entropy)"
rm -f "$OUT/withdraw_0000.zkey"
npx snarkjs zkey export verificationkey "$OUT/withdraw.zkey" "$OUT/withdraw_vkey.json"
npx snarkjs zkey export solidityverifier "$OUT/withdraw.zkey" contracts/Groth16Verifier.sol

mkdir -p zk
cp "$OUT/withdraw_js/withdraw.wasm" zk/withdraw.wasm
cp "$OUT/withdraw.zkey" zk/withdraw.zkey
cp "$OUT/withdraw_vkey.json" zk/withdraw_vkey.json
echo "circuit artifacts written to zk/"
