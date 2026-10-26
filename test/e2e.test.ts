import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { getAddress, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEV_KEYS, loadConfig, type Config } from "../src/config";
import { makePublicClient, makeWalletClient } from "../src/core/chain";
import type { Deployment } from "../src/core/deployment";
import { keysFromMnemonic, newMnemonic, noteSecrets, type ZeroupKeys } from "../src/core/keys";
import { encryptMemo } from "../src/core/memo";
import { MerkleTree } from "../src/core/merkle";
import { initPoseidon, poseidon } from "../src/core/poseidon";
import { proveWithdraw, shutdownProver } from "../src/core/prover";
import { HEADER_PAYMENT_SIGNATURE, decodeHeader, encodeHeader, type PaymentPayload } from "../src/core/x402";
import { ZeroupPool, MockUSDC } from "../src/generated/contracts";
import { deployLocal, startLocalChain, startServices, type RunningServices } from "../src/stack";
import { auditWithViewingKey } from "../src/wallet/auditor";
import { PolicyError } from "../src/wallet/policy";
import { ZeroupWallet, withdrawContext, TREE_LEVELS } from "../src/wallet/wallet";
import { createPrivateFetch } from "../src/wallet/x402-fetch";

const RPC = "http://127.0.0.1:8746";
const PORTS = { sponsor: 5710, facilitator: 5720, merchant: 5730, wallet: 5740 };

let cfg: Config;
let chain: { stop: () => void };
let d: Deployment;
let svc: RunningServices;
let client: PublicClient;
let tmp: string;
const funder = privateKeyToAccount(DEV_KEYS.funder);

async function openWallet(keys: ZeroupKeys, name: string, policy?: ZeroupWallet["policy"]) {
  return ZeroupWallet.open({
    keys,
    deployment: d,
    publicClient: client,
    sponsorUrl: svc.sponsorUrl,
    stateFile: path.join(tmp, `${name}.bin`),
    policy,
  });
}

async function post(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  });
  return { status: res.status, body: (await res.json()) as { error?: string; txHash?: Hex } };
}

/** Builds a valid withdrawal (proof + request) for a wallet's first note without submitting it. */
async function buildWithdrawal(keys: ZeroupKeys, noteIndex: number, leafIndex: number, value: bigint, recipient: Hex, amount: bigint) {
  const tree = new MerkleTree(TREE_LEVELS);
  const leaves = await client.getContractEvents({ address: d.pool, abi: ZeroupPool.abi, eventName: "Deposit", fromBlock: BigInt(d.deployBlock) });
  const wds = await client.getContractEvents({ address: d.pool, abi: ZeroupPool.abi, eventName: "Withdrawal", fromBlock: BigInt(d.deployBlock) });
  const all = [
    ...leaves.map((e) => [Number(e.args.leafIndex), e.args.commitment!] as const),
    ...wds.map((e) => [Number(e.args.leafIndex), e.args.newCommitment!] as const),
  ].sort((a, b) => a[0] - b[0]);
  for (const [, c] of all) tree.insert(c);
  const info = (await (await fetch(`${svc.sponsorUrl}/v1/info`)).json()) as { address: Hex; withdrawFee: string };
  const fee = BigInt(info.withdrawFee);
  const s = noteSecrets(keys, noteIndex);
  const change = noteSecrets(keys, 999);
  const newCommitment = poseidon([value - amount - fee, change.precommitment]);
  const encryptedNote = encryptMemo(keys.viewingKey, { v: 1, kind: "deposit", noteIndex: 999, value: "0", ts: 0 });
  const context = withdrawContext(d.chainId, d.pool, recipient, info.address, fee, encryptedNote);
  const p = tree.path(leafIndex);
  const proof = await proveWithdraw({
    root: tree.root(),
    nullifierHash: s.nullifierHash,
    withdrawnValue: amount + fee,
    newCommitment,
    context,
    value,
    nullifier: s.nullifier,
    secret: s.secret,
    newNullifier: change.nullifier,
    newSecret: change.secret,
    pathElements: p.pathElements,
    pathIndices: p.pathIndices,
  });
  const request = {
    root: tree.root(),
    nullifierHash: s.nullifierHash,
    withdrawnValue: amount + fee,
    newCommitment,
    recipient,
    relayer: info.address,
    fee,
    encryptedNote,
  };
  return { proof, request };
}

describe("zeroup end-to-end", () => {
  before(async () => {
    await initPoseidon();
    cfg = { ...loadConfig(), network: "localhost", isLocal: true, chainId: 31337, rpcUrl: RPC, ports: PORTS };
    chain = await startLocalChain(RPC);
    d = await deployLocal(cfg);
    svc = await startServices(cfg, d);
    client = makePublicClient(RPC, 31337);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zeroup-test-"));
  });

  after(async () => {
    await svc?.close();
    chain?.stop();
    await shutdownProver();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("gasless deposit, private payments, unlinkable payers, auditor view", async () => {
    const keys = keysFromMnemonic(newMnemonic());
    const w = await openWallet(keys, "a");
    const eth0 = await client.getBalance({ address: funder.address });
    await w.deposit(funder, 2_000_000n);
    assert.equal(await client.getBalance({ address: funder.address }), eth0, "depositor paid no gas");
    assert.equal(w.balance(), 2_000_000n);

    // The wallet's tree must agree with the contract's.
    const onchainRoot = await client.readContract({ address: d.pool, abi: ZeroupPool.abi, functionName: "getLastRoot" });
    const tree = new MerkleTree(TREE_LEVELS);
    const deps = await client.getContractEvents({ address: d.pool, abi: ZeroupPool.abi, eventName: "Deposit", fromBlock: BigInt(d.deployBlock) });
    for (const e of deps) tree.insert(e.args.commitment!);
    assert.equal(tree.root(), onchainRoot);

    const pf = createPrivateFetch(w);
    const r1 = await pf(`${svc.merchantUrl}/api/weather?city=Oslo`);
    const r2 = await pf(`${svc.merchantUrl}/api/quote/BTC`);
    assert.equal(r1.response.status, 200);
    assert.equal(r2.response.status, 200);
    assert.ok(r1.payment?.settlement?.success);
    const payers = [r1.payment!.record.payer, r2.payment!.record.payer].map((a) => getAddress(a));
    assert.notEqual(payers[0], payers[1]);
    assert.ok(!payers.includes(getAddress(funder.address)));
    for (const p of payers) assert.equal(await client.getTransactionCount({ address: p }), 0, "payer never sent a tx");

    const fee = BigInt(cfg.sponsorWithdrawFee);
    assert.equal(w.balance(), 2_000_000n - 10_000n - 20_000n - 2n * fee);
    const paidCount = w.payments().filter((p) => p.status === "paid").length;
    assert.equal(paidCount, 2);

    const report = await auditWithViewingKey(keys.viewingKey, client, d);
    assert.equal(report.totals.shieldedBalance, w.balance().toString());
    assert.equal(report.totals.paid, "30000");
    assert.equal(report.entries.filter((e) => e.kind === "payment").length, 2);
  });

  test("wallet recovers notes and history from the seed alone", async () => {
    const mnemonic = newMnemonic();
    const w = await openWallet(keysFromMnemonic(mnemonic), "rec1");
    await w.deposit(funder, 1_000_000n);
    await createPrivateFetch(w)(`${svc.merchantUrl}/api/report`);
    const restored = await openWallet(keysFromMnemonic(mnemonic), "rec2");
    await restored.sync();
    assert.equal(restored.balance(), w.balance());
    assert.equal(restored.payments().length, 1);
    // New activity after recovery must not reuse indices.
    await restored.deposit(funder, 1_000n);
    assert.equal(restored.balance(), w.balance() + 1_000n);
  });

  test("payment that spans several notes", async () => {
    const w = await openWallet(keysFromMnemonic(newMnemonic()), "multi");
    await w.deposit(funder, 30_000n);
    await w.deposit(funder, 30_000n);
    const { response, payment } = await createPrivateFetch(w)(`${svc.merchantUrl}/api/report`); // 0.05
    assert.equal(response.status, 200);
    assert.equal(payment!.record.withdrawTxs.length, 2);
    assert.equal(w.balance(), 60_000n - 50_000n - 2n * BigInt(cfg.sponsorWithdrawFee));
  });

  test("exit to a public address", async () => {
    const w = await openWallet(keysFromMnemonic(newMnemonic()), "exit");
    await w.deposit(funder, 500_000n);
    const dest = privateKeyToAccount(DEV_KEYS.merchant).address;
    const before = await client.readContract({ address: d.token, abi: MockUSDC.abi, functionName: "balanceOf", args: [dest] });
    await w.exit(dest, 200_000n);
    const after = await client.readContract({ address: d.token, abi: MockUSDC.abi, functionName: "balanceOf", args: [dest] });
    assert.equal(after - before, 200_000n);
    assert.equal(w.balance(), 300_000n - BigInt(cfg.sponsorWithdrawFee));
  });

  test("policy blocks spending over the limit before any money moves", async () => {
    const w = await openWallet(keysFromMnemonic(newMnemonic()), "policy", { maxPerPayment: 15_000n, dailyBudget: 1_000_000n });
    await w.deposit(funder, 1_000_000n);
    await assert.rejects(createPrivateFetch(w)(`${svc.merchantUrl}/api/quote/ETH`), PolicyError);
    assert.equal(w.balance(), 1_000_000n);
  });

  test("screened addresses cannot deposit", async () => {
    const w = await openWallet(keysFromMnemonic(newMnemonic()), "blocked");
    await assert.rejects(w.deposit(privateKeyToAccount(DEV_KEYS.blocked), 1_000n), /blocked/);
  });

  test("double spend, tampered recipient and tampered fee are rejected", async () => {
    const keys = keysFromMnemonic(newMnemonic());
    const w = await openWallet(keys, "adv");
    const { leafIndex } = await w.deposit(funder, 100_000n);
    const recipient = privateKeyToAccount(DEV_KEYS.merchant).address;
    const { proof, request } = await buildWithdrawal(keys, 0, leafIndex, 100_000n, recipient, 10_000n);

    // A relayer (or anyone) redirecting the funds invalidates the proof.
    const attacker = privateKeyToAccount(DEV_KEYS.deployer).address;
    const redirected = await post(`${svc.sponsorUrl}/v1/withdraw`, { proof, request: { ...request, recipient: attacker } });
    assert.equal(redirected.status, 400);
    assert.match(redirected.body.error!, /invalid proof/);

    // Even submitted straight to the contract, bypassing the sponsor.
    const anyone = makeWalletClient(RPC, 31337, DEV_KEYS.deployer);
    const solProof = {
      a: proof.a.map(BigInt) as [bigint, bigint],
      b: proof.b.map((r) => r.map(BigInt)) as [[bigint, bigint], [bigint, bigint]],
      c: proof.c.map(BigInt) as [bigint, bigint],
    };
    await assert.rejects(
      client.simulateContract({
        account: anyone.account,
        address: d.pool,
        abi: ZeroupPool.abi,
        functionName: "withdraw",
        args: [solProof, { ...request, fee: request.fee + 1n }],
      }),
      /InvalidProof/,
    );

    const ok = await post(`${svc.sponsorUrl}/v1/withdraw`, { proof, request });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const replay = await post(`${svc.sponsorUrl}/v1/withdraw`, { proof, request });
    assert.equal(replay.status, 409);
    await assert.rejects(
      client.simulateContract({ account: anyone.account, address: d.pool, abi: ZeroupPool.abi, functionName: "withdraw", args: [solProof, request] }),
      /NullifierSpent/,
    );
  });

  test("x402 payment payloads cannot be replayed or altered", async () => {
    const w = await openWallet(keysFromMnemonic(newMnemonic()), "replay");
    await w.deposit(funder, 1_000_000n);
    const url = `${svc.merchantUrl}/api/weather?city=Rome`;
    const first = await fetch(url);
    assert.equal(first.status, 402);
    const required = decodeHeader<{ accepts: PaymentPayload["accepted"][]; resource: { url: string } }>(first.headers.get("PAYMENT-REQUIRED")!);
    const { payload } = await w.pay(required.accepts[0], required.resource);

    const tampered: PaymentPayload = { ...payload, payload: { ...payload.payload, authorization: { ...payload.payload.authorization, value: "1" } } };
    const bad = await fetch(url, { headers: { [HEADER_PAYMENT_SIGNATURE]: encodeHeader(tampered) } });
    assert.equal(bad.status, 402);

    const good = await fetch(url, { headers: { [HEADER_PAYMENT_SIGNATURE]: encodeHeader(payload) } });
    assert.equal(good.status, 200);
    const replay = await fetch(url, { headers: { [HEADER_PAYMENT_SIGNATURE]: encodeHeader(payload) } });
    assert.equal(replay.status, 402);
    const reason = decodeHeader<{ error: string }>(replay.headers.get("PAYMENT-REQUIRED")!).error;
    assert.match(reason, /nonce_used|insufficient_funds/);
  });
});
