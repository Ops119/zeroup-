import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import http from "http";
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
import { createWalletServer } from "../src/services/wallet-server";
import { createFacilitatorApp } from "../src/services/facilitator";
import { listen } from "../src/services/http";
import { depositNonce } from "../src/wallet/wallet";
import { RECEIVE_WITH_AUTHORIZATION_TYPES, tokenDomain } from "../src/core/eip3009";
import { parseSignature, serializeCompactSignature, signatureToCompactSignature } from "viem";

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
    await restored.deposit(funder, 10_000n);
    assert.equal(restored.balance(), w.balance() + 10_000n);
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

  test("unsettled payments are reclaimed into the pool after their authorization expires", async () => {
    const w = await openWallet(keysFromMnemonic(newMnemonic()), "reclaim");
    await w.deposit(funder, 1_000_000n);
    const first = await fetch(`${svc.merchantUrl}/api/report`);
    const required = decodeHeader<{ accepts: PaymentPayload["accepted"][]; resource: { url: string } }>(first.headers.get("PAYMENT-REQUIRED")!);
    // Fund a payer and sign, but never send the payment (merchant unreachable, crash...).
    const { record } = await w.pay({ ...required.accepts[0], maxTimeoutSeconds: 1 }, required.resource);
    const fee = BigInt(cfg.sponsorWithdrawFee);
    assert.equal(w.balance(), 1_000_000n - 50_000n - fee);
    assert.deepEqual(await w.reclaim(), [], "not reclaimed while the authorization is still valid");
    const out = await w.reclaim({ now: Date.now() + 5_000 });
    assert.equal(out.length, 1);
    assert.equal(getAddress(out[0].payer), getAddress(record.payer));
    assert.equal(w.balance(), 1_000_000n - fee);
    assert.equal(w.payments()[0].status, "reclaimed");
    const report = await auditWithViewingKey(keysFromMnemonic(newMnemonic()).viewingKey, client, d);
    assert.equal(report.entries.length, 0, "other keys see nothing");
  });

  test("sponsor accepts compact (EIP-2098) signatures and rejects dust deposits", async () => {
    await initPoseidon();
    const keys = keysFromMnemonic(newMnemonic());
    const s = noteSecrets(keys, 0);
    const memo = encryptMemo(keys.viewingKey, { v: 1, kind: "deposit", noteIndex: 0, value: "20000", ts: 0 });
    const now = BigInt(Math.floor(Date.now() / 1000));
    const message = { from: funder.address, to: d.pool, value: 20_000n, validAfter: now - 60n, validBefore: now + 600n, nonce: depositNonce(d.chainId, d.pool, s.precommitment, memo) };
    const sig = await funder.signTypedData({
      domain: tokenDomain(d.tokenName, d.tokenVersion, d.chainId, d.token),
      types: RECEIVE_WITH_AUTHORIZATION_TYPES,
      primaryType: "ReceiveWithAuthorization",
      message,
    });
    const compact = serializeCompactSignature(signatureToCompactSignature(parseSignature(sig)));
    const ok = await post(`${svc.sponsorUrl}/v1/deposit`, { ...message, signature: compact, precommitment: s.precommitment, encryptedNote: memo });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const dust = await post(`${svc.sponsorUrl}/v1/deposit`, { ...message, value: 1n, signature: compact, precommitment: s.precommitment, encryptedNote: memo });
    assert.equal(dust.status, 400);
    assert.match(dust.body.error!, /minimum/);
    const badJson = await fetch(`${svc.sponsorUrl}/v1/deposit`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    assert.equal(badJson.status, 400);
  });

  test("merchant answers malformed payments with 402, not a crash", async () => {
    const bogus = { x402Version: 2, accepted: { scheme: "exact", network: "eip155:31337", amount: "50000", asset: "zzz", payTo: "0x1" }, payload: {} };
    const res = await fetch(`${svc.merchantUrl}/api/report`, { headers: { [HEADER_PAYMENT_SIGNATURE]: encodeHeader(bogus) } });
    assert.equal(res.status, 402);
    const garbage = await fetch(`${svc.merchantUrl}/api/report`, { headers: { [HEADER_PAYMENT_SIGNATURE]: "!!!" } });
    assert.equal(garbage.status, 400);
  });

  test("facilitator with an API key refuses unauthenticated callers", async () => {
    const app = createFacilitatorApp({ deployment: d, publicClient: client, wallet: makeWalletClient(RPC, 31337, DEV_KEYS.facilitator), apiKey: "s3cret" });
    const server = await listen(app, 5799);
    try {
      const anon = await fetch("http://127.0.0.1:5799/settle", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(anon.status, 401);
      const authed = await fetch("http://127.0.0.1:5799/verify", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer s3cret" }, body: "{}" });
      assert.equal(((await authed.json()) as { isValid: boolean }).isValid, false);
      assert.equal((await fetch("http://127.0.0.1:5799/supported")).status, 200);
    } finally {
      server.close();
    }
  });

  test("wallet daemon blocks DNS-rebinding hosts and non-JSON posts", async () => {
    const keys = keysFromMnemonic(newMnemonic());
    const w = await openWallet(keys, "daemon");
    const server = await listen(createWalletServer({ wallet: w, keys, publicClient: client }), 5798);
    try {
      // fetch() ignores custom Host headers, so use node:http like a rebinding browser would arrive.
      const status = (host: string) =>
        new Promise<number>((resolve, reject) =>
          http.get({ host: "127.0.0.1", port: 5798, path: "/api/viewing-key", headers: { host } }, (r) => {
            r.resume();
            resolve(r.statusCode!);
          }).on("error", reject),
        );
      assert.equal(await status("evil.example:5798"), 403);
      assert.equal(await status("localhost:5798"), 200);
      const ok = await fetch("http://127.0.0.1:5798/api/viewing-key");
      assert.equal(ok.status, 200);
      const form = await fetch("http://127.0.0.1:5798/api/exit", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
      assert.equal(form.status, 415);
    } finally {
      server.close();
    }
  });

  test("a corrupt state file is set aside and rebuilt from the chain", async () => {
    const mnemonic = newMnemonic();
    const w = await openWallet(keysFromMnemonic(mnemonic), "corrupt");
    await w.deposit(funder, 30_000n);
    fs.writeFileSync(path.join(tmp, "corrupt.bin"), "garbage");
    const again = await openWallet(keysFromMnemonic(mnemonic), "corrupt");
    await again.sync();
    assert.equal(again.balance(), 30_000n);
    assert.ok(fs.readdirSync(tmp).some((f) => f.startsWith("corrupt.bin.corrupt-")));
  });
});
