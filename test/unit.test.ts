import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "crypto";
import { initPoseidon, poseidon } from "../src/core/poseidon";
import { MerkleTree } from "../src/core/merkle";
import { keysFromMnemonic, newMnemonic, noteSecrets, payerPrivateKey } from "../src/core/keys";
import { decryptMemo, encryptMemo } from "../src/core/memo";
import { checkStealthAddress, generateStealthAddress, stealthMetaAddress } from "../src/core/stealth";
import { decodeHeader, encodeHeader } from "../src/core/x402";
import { checkPolicy, PolicyError } from "../src/wallet/policy";

test("poseidon matches circomlib reference vector", async () => {
  await initPoseidon();
  // Poseidon([1, 2]) from the circomlib test suite.
  assert.equal(poseidon([1n, 2n]), 0x115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189an);
});

test("merkle paths reproduce the root", async () => {
  await initPoseidon();
  const tree = new MerkleTree(20);
  for (let i = 0n; i < 7n; i++) tree.insert(1000n + i);
  for (let i = 0; i < 7; i++) {
    const { pathElements, pathIndices } = tree.path(i);
    let h = tree.leaf(i)!;
    for (let l = 0; l < 20; l++) h = pathIndices[l] ? poseidon([pathElements[l], h]) : poseidon([h, pathElements[l]]);
    assert.equal(h, tree.root());
  }
});

test("keys are deterministic and separated", async () => {
  await initPoseidon();
  const m = newMnemonic();
  const a = keysFromMnemonic(m);
  const b = keysFromMnemonic(m);
  assert.deepEqual(noteSecrets(a, 3), noteSecrets(b, 3));
  assert.notEqual(noteSecrets(a, 3).nullifier, noteSecrets(a, 4).nullifier);
  assert.notEqual(payerPrivateKey(a, 0), payerPrivateKey(a, 1));
  assert.notDeepEqual(a.viewingKey, a.spendingKey);
  assert.throws(() => keysFromMnemonic("not a mnemonic"));
});

test("memos decrypt only with the right viewing key and are length-bucketed", () => {
  const vk = randomBytes(32);
  const memo = { v: 1 as const, kind: "deposit" as const, noteIndex: 7, value: "123", ts: 1 };
  const ct = encryptMemo(vk, memo);
  assert.deepEqual(decryptMemo(vk, ct), memo);
  assert.equal(decryptMemo(randomBytes(32), ct), null);
  assert.equal(decryptMemo(vk, "0x00"), null);
  assert.equal((ct.length - 2) / 2, 1 + 24 + 128 + 16);
});

test("ERC-5564 stealth addresses: recipient finds and controls them, others do not", () => {
  const keys = keysFromMnemonic(newMnemonic());
  const meta = stealthMetaAddress(keys.stealthSpendingKey, keys.stealthViewingKey);
  const gen = generateStealthAddress(meta.encoded);
  const priv = checkStealthAddress(gen, keys.stealthSpendingKey, keys.stealthViewingKey);
  assert.ok(priv);
  const other = keysFromMnemonic(newMnemonic());
  assert.equal(checkStealthAddress(gen, other.stealthSpendingKey, other.stealthViewingKey), null);
});

test("x402 headers round-trip as base64 JSON", () => {
  const v = { x402Version: 2, accepts: [{ scheme: "exact", amount: "10000" }] };
  assert.deepEqual(decodeHeader(encodeHeader(v)), v);
});

test("spend policy enforces per-payment, daily and host limits", () => {
  const policy = { maxPerPayment: 100n, dailyBudget: 250n, allowedHosts: ["api.example.com"] };
  const ok = { amount: 100n, fee: 10n, payTo: "0x1", url: "https://api.example.com/x" };
  checkPolicy(policy, ok, []);
  assert.throws(() => checkPolicy(policy, { ...ok, amount: 101n }, []), PolicyError);
  assert.throws(() => checkPolicy(policy, { ...ok, url: "https://evil.example/x" }, []), PolicyError);
  const history = [{ status: "paid", ts: Date.now(), amount: "100", fee: "10" }, { status: "paid", ts: Date.now(), amount: "30", fee: "10" }];
  assert.throws(() => checkPolicy(policy, ok, history as never), PolicyError);
  const old = history.map((h) => ({ ...h, ts: Date.now() - 2 * 86_400_000 }));
  checkPolicy(policy, ok, old as never);
});
