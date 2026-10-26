import fs from "fs";
import path from "path";
import { randomBytes, randomUUID } from "crypto";
import {
  bytesToHex,
  encodeAbiParameters,
  getAddress,
  keccak256,
  type Hex,
  type LocalAccount,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ZeroupPool } from "../generated/contracts";
import type { Deployment } from "../core/deployment";
import { FIELD } from "../core/field";
import { initPoseidon, poseidon } from "../core/poseidon";
import { MerkleTree } from "../core/merkle";
import { noteSecrets, payerPrivateKey, type ZeroupKeys } from "../core/keys";
import { decryptMemo, encryptMemo, type Memo } from "../core/memo";
import { proveWithdraw, type SolidityProof } from "../core/prover";
import { RECEIVE_WITH_AUTHORIZATION_TYPES, TRANSFER_WITH_AUTHORIZATION_TYPES, tokenDomain } from "../core/eip3009";
import { SerialQueue } from "../core/chain";
import {
  X402_VERSION,
  caip2,
  type PaymentPayload,
  type PaymentRequirements,
  type ResourceInfo,
  type SettleResponse,
} from "../core/x402";
import { StateStore, emptyState, type NoteRecord, type PaymentRecord, type WalletState } from "./store";
import { DEFAULT_POLICY, checkPolicy, type SpendPolicy } from "./policy";

export const TREE_LEVELS = 20;

export type TypedDataSigner = Pick<LocalAccount, "address" | "signTypedData">;

export interface SponsorInfo {
  address: Hex;
  network: string;
  chainId: number;
  pool: Hex;
  token: Hex;
  withdrawFee: string;
}

export interface ZeroupWalletOptions {
  keys: ZeroupKeys;
  deployment: Deployment;
  publicClient: PublicClient;
  sponsorUrl: string;
  stateFile: string;
  policy?: SpendPolicy;
  logChunkSize?: bigint;
  log?: (msg: string) => void;
}

export class InsufficientFundsError extends Error {}

/** Public input binding a withdrawal proof; must match ZeroupPool.withdrawContext. */
export function withdrawContext(chainId: number, pool: Hex, recipient: Hex, relayer: Hex, fee: bigint, encryptedNote: Hex): bigint {
  const encoded = encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }],
    [BigInt(chainId), pool, recipient, relayer, fee, keccak256(encryptedNote)],
  );
  return BigInt(keccak256(encoded)) % FIELD;
}

/** EIP-3009 nonce for a gasless deposit; must match ZeroupPool.depositNonce. */
export function depositNonce(chainId: number, pool: Hex, precommitment: bigint, encryptedNote: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }],
      [BigInt(chainId), pool, precommitment, keccak256(encryptedNote)],
    ),
  );
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(`${url}: ${json.error ?? res.statusText}`);
  return json;
}

/**
 * One process per wallet: two processes allocating note indices at once could
 * create two notes with the same nullifier, making one of them unspendable.
 */
function acquireLock(lockFile: string): void {
  const pid = String(process.pid);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  for (;;) {
    try {
      fs.writeFileSync(lockFile, pid, { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = Number(fs.readFileSync(lockFile, "utf8"));
      if (holder === process.pid) return;
      if (holder && isAlive(holder)) {
        throw new Error(`wallet is in use by process ${holder}; stop it or use its API instead`);
      }
      fs.rmSync(lockFile, { force: true }); // stale lock from a dead process
    }
  }
  process.once("exit", () => {
    try {
      if (fs.readFileSync(lockFile, "utf8") === pid) fs.rmSync(lockFile, { force: true });
    } catch {
      /* already gone */
    }
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface WithdrawStep {
  note: NoteRecord;
  withdrawn: bigint;
}

/**
 * A Zeroup wallet: a shielded balance in ZeroupPool plus a one-time payer
 * account per x402 payment. Merchants, facilitators and chain observers only
 * ever see the payer account, which has no history and no on-chain link to the
 * wallet that funded the pool.
 */
export class ZeroupWallet {
  private readonly queue = new SerialQueue();
  private readonly store: StateStore;
  private state!: WalletState;
  private tree!: MerkleTree;
  private sponsorInfoCache?: SponsorInfo;
  readonly policy: SpendPolicy;

  private constructor(private readonly opts: ZeroupWalletOptions) {
    this.store = new StateStore(opts.stateFile, opts.keys.viewingKey);
    this.policy = opts.policy ?? DEFAULT_POLICY;
  }

  static async open(opts: ZeroupWalletOptions): Promise<ZeroupWallet> {
    await initPoseidon();
    acquireLock(`${opts.stateFile}.lock`);
    const w = new ZeroupWallet(opts);
    const d = opts.deployment;
    const loaded = w.store.load();
    // Local state is only a cache: everything in it can be rebuilt from the
    // chain and the seed, so discard it whenever it may belong to another chain.
    const anchor = await opts.publicClient
      .getBlock({ blockNumber: BigInt(d.deployBlock) })
      .then((b) => b.hash, () => undefined);
    const latest = await opts.publicClient.getBlockNumber();
    w.state =
      loaded &&
      loaded.chainId === d.chainId &&
      loaded.pool.toLowerCase() === d.pool.toLowerCase() &&
      loaded.anchor === anchor &&
      BigInt(loaded.lastSyncedBlock) <= latest
        ? loaded
        : emptyState(d.chainId, d.pool, BigInt(d.deployBlock), anchor);
    w.tree = new MerkleTree(TREE_LEVELS);
    for (const leaf of w.state.leaves) w.tree.insert(BigInt(leaf));
    return w;
  }

  get network(): string {
    return caip2(this.opts.deployment.chainId);
  }

  get deployment(): Deployment {
    return this.opts.deployment;
  }

  get viewingKey(): Hex {
    return bytesToHex(this.opts.keys.viewingKey);
  }

  balance(): bigint {
    return this.state.notes.filter((n) => !n.spent).reduce((s, n) => s + BigInt(n.value), 0n);
  }

  notes(): NoteRecord[] {
    return this.state.notes.map((n) => ({ ...n }));
  }

  payments(): PaymentRecord[] {
    return this.state.payments.map((p) => ({ ...p, withdrawTxs: [...p.withdrawTxs] }));
  }

  /** Address of the one-time account for a given payment index (for audits/sweeps). */
  payerAddress(index: number): Hex {
    return privateKeyToAccount(payerPrivateKey(this.opts.keys, index)).address;
  }

  async sponsorInfo(): Promise<SponsorInfo> {
    if (!this.sponsorInfoCache) {
      const res = await fetch(`${this.opts.sponsorUrl}/v1/info`);
      if (!res.ok) throw new Error(`sponsor unavailable: ${res.status}`);
      this.sponsorInfoCache = (await res.json()) as SponsorInfo;
    }
    return this.sponsorInfoCache;
  }

  sync(): Promise<void> {
    return this.queue.run(() => this.syncUnlocked());
  }

  /**
   * Gasless deposit. The funding wallet signs an EIP-3009
   * ReceiveWithAuthorization whose nonce commits to the new note; the sponsor
   * submits it and pays gas. This is the only step that touches the funding
   * wallet, and it reveals only "this wallet deposited N into the pool".
   */
  deposit(funder: TypedDataSigner, amount: bigint): Promise<{ txHash: Hex; leafIndex: number }> {
    return this.queue.run(async () => {
      if (amount <= 0n) throw new Error("amount must be positive");
      await this.syncUnlocked();
      const d = this.opts.deployment;
      const noteIndex = this.allocateNoteIndex();
      const s = noteSecrets(this.opts.keys, noteIndex);
      const memo = encryptMemo(this.opts.keys.viewingKey, {
        v: 1,
        kind: "deposit",
        noteIndex,
        value: amount.toString(),
        ts: Date.now(),
      });
      const now = BigInt(Math.floor(Date.now() / 1000));
      const message = {
        from: getAddress(funder.address),
        to: d.pool,
        value: amount,
        validAfter: now - 60n,
        validBefore: now + 3600n,
        nonce: depositNonce(d.chainId, d.pool, s.precommitment, memo),
      };
      const signature = await funder.signTypedData({
        domain: tokenDomain(d.tokenName, d.tokenVersion, d.chainId, d.token),
        types: RECEIVE_WITH_AUTHORIZATION_TYPES,
        primaryType: "ReceiveWithAuthorization",
        message,
      });
      const res = await postJson<{ txHash: Hex; leafIndex: number }>(`${this.opts.sponsorUrl}/v1/deposit`, {
        ...message,
        signature,
        precommitment: s.precommitment,
        encryptedNote: memo,
      });
      this.log(`deposited ${amount} (note #${noteIndex}, leaf ${res.leafIndex}) tx ${res.txHash}`);
      await this.syncUnlocked();
      return res;
    });
  }

  /**
   * Funds a fresh one-time account from the shielded balance and signs an
   * x402 "exact" payload from it. Returns the payload to send in
   * PAYMENT-SIGNATURE.
   */
  pay(requirements: PaymentRequirements, resource: ResourceInfo): Promise<{ payload: PaymentPayload; record: PaymentRecord }> {
    return this.queue.run(async () => {
      const d = this.opts.deployment;
      if (requirements.scheme !== "exact") throw new Error(`unsupported scheme ${requirements.scheme}`);
      if (requirements.network !== this.network) throw new Error(`unsupported network ${requirements.network}`);
      if (getAddress(requirements.asset) !== getAddress(d.token)) throw new Error(`unsupported asset ${requirements.asset}`);
      const amount = BigInt(requirements.amount);
      if (amount <= 0n) throw new Error("invalid amount");
      const payTo = getAddress(requirements.payTo);

      const info = await this.sponsorInfo();
      const fee = BigInt(info.withdrawFee);
      await this.syncUnlocked();
      const plan = this.plan(amount, fee);
      checkPolicy(this.policy, { amount, fee: fee * BigInt(plan.length), payTo, url: resource.url }, this.state.payments);

      const payerIndex = this.state.nextPayerIndex++;
      this.persist();
      const payer = privateKeyToAccount(payerPrivateKey(this.opts.keys, payerIndex));
      const record: PaymentRecord = {
        id: randomUUID(),
        ts: Date.now(),
        resource: resource.url,
        network: requirements.network,
        payTo,
        amount: amount.toString(),
        fee: (fee * BigInt(plan.length)).toString(),
        payer: payer.address,
        payerIndex,
        withdrawTxs: [],
        status: "funded",
      };
      this.state.payments.push(record);
      this.persist();

      try {
        for (const step of plan) {
          const tx = await this.withdrawNote(step, payer.address, info, (changeIndex, change) => ({
            v: 1,
            kind: "payment",
            noteIndex: changeIndex,
            value: change.toString(),
            spentNoteIndex: step.note.noteIndex,
            payer: payer.address,
            payerIndex,
            payTo,
            amount: amount.toString(),
            fee: fee.toString(),
            resource: resource.url,
            ts: record.ts,
          }));
          record.withdrawTxs.push(tx);
          this.persist();
        }
      } catch (err) {
        record.status = "failed";
        record.error = (err as Error).message;
        this.persist();
        throw err;
      }

      const now = BigInt(Math.floor(Date.now() / 1000));
      const authorization = {
        from: payer.address,
        to: payTo,
        value: amount,
        validAfter: now - 30n,
        validBefore: now + BigInt(requirements.maxTimeoutSeconds || 60),
        nonce: bytesToHex(randomBytes(32)),
      };
      const extra = (requirements.extra ?? {}) as { name?: string; version?: string };
      const signature = await payer.signTypedData({
        domain: tokenDomain(extra.name ?? d.tokenName, extra.version ?? d.tokenVersion, d.chainId, getAddress(requirements.asset)),
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: "TransferWithAuthorization",
        message: authorization,
      });
      const payload: PaymentPayload = {
        x402Version: X402_VERSION,
        resource,
        accepted: requirements,
        payload: {
          signature,
          authorization: {
            from: authorization.from,
            to: authorization.to,
            value: authorization.value.toString(),
            validAfter: authorization.validAfter.toString(),
            validBefore: authorization.validBefore.toString(),
            nonce: authorization.nonce,
          },
        },
      };
      return { payload, record: { ...record } };
    });
  }

  /** Records the merchant's PAYMENT-RESPONSE for a payment. */
  recordSettlement(id: string, settlement: SettleResponse | undefined, httpStatus?: number): Promise<void> {
    return this.queue.run(async () => {
      const p = this.state.payments.find((x) => x.id === id);
      if (!p) return;
      if (settlement?.success) {
        p.status = "paid";
        p.settleTx = settlement.transaction;
      } else {
        p.status = "failed";
        p.error = settlement?.errorReason ?? `merchant returned HTTP ${httpStatus ?? "?"}`;
      }
      this.persist();
    });
  }

  /** Public exit: move shielded funds to any address (e.g. back to the user's main wallet). */
  exit(to: Hex, amount: bigint): Promise<Hex[]> {
    return this.queue.run(async () => {
      const recipient = getAddress(to);
      const info = await this.sponsorInfo();
      const fee = BigInt(info.withdrawFee);
      await this.syncUnlocked();
      const txs: Hex[] = [];
      for (const step of this.plan(amount, fee)) {
        txs.push(
          await this.withdrawNote(step, recipient, info, (changeIndex, change) => ({
            v: 1,
            kind: "withdraw",
            noteIndex: changeIndex,
            value: change.toString(),
            spentNoteIndex: step.note.noteIndex,
            to: recipient,
            amount: (step.withdrawn - fee).toString(),
            fee: fee.toString(),
            ts: Date.now(),
          })),
        );
      }
      return txs;
    });
  }

  // ------------------------------------------------------------------ private

  private plan(amount: bigint, fee: bigint): WithdrawStep[] {
    const unspent = this.state.notes.filter((n) => !n.spent && BigInt(n.value) > 0n);
    const asc = [...unspent].sort((a, b) => (BigInt(a.value) < BigInt(b.value) ? -1 : 1));
    const single = asc.find((n) => BigInt(n.value) >= amount + fee);
    if (single) return [{ note: single, withdrawn: amount + fee }];

    const steps: WithdrawStep[] = [];
    let need = amount;
    for (const note of asc.reverse()) {
      const v = BigInt(note.value);
      if (v <= fee) continue;
      const take = v - fee < need ? v - fee : need;
      steps.push({ note, withdrawn: take + fee });
      need -= take;
      if (need === 0n) return steps;
    }
    throw new InsufficientFundsError(`shielded balance too low: need ${amount} + fees, have ${this.balance()}`);
  }

  private async withdrawNote(
    step: WithdrawStep,
    recipient: Hex,
    sponsor: SponsorInfo,
    memoFor: (changeIndex: number, change: bigint) => Memo,
  ): Promise<Hex> {
    const d = this.opts.deployment;
    const fee = BigInt(sponsor.withdrawFee);
    const spent = noteSecrets(this.opts.keys, step.note.noteIndex);
    const changeIndex = this.allocateNoteIndex();
    const change = noteSecrets(this.opts.keys, changeIndex);
    const value = BigInt(step.note.value);
    const remaining = value - step.withdrawn;
    const newCommitment = poseidon([remaining, change.precommitment]);
    const encryptedNote = encryptMemo(this.opts.keys.viewingKey, memoFor(changeIndex, remaining));
    const context = withdrawContext(d.chainId, d.pool, recipient, sponsor.address, fee, encryptedNote);
    const root = this.tree.root();
    const merklePath = this.tree.path(step.note.leafIndex);

    const started = Date.now();
    const proof: SolidityProof = await proveWithdraw({
      root,
      nullifierHash: spent.nullifierHash,
      withdrawnValue: step.withdrawn,
      newCommitment,
      context,
      value,
      nullifier: spent.nullifier,
      secret: spent.secret,
      newNullifier: change.nullifier,
      newSecret: change.secret,
      pathElements: merklePath.pathElements,
      pathIndices: merklePath.pathIndices,
    });
    this.log(`proved withdrawal of note #${step.note.noteIndex} in ${Date.now() - started}ms`);

    const res = await postJson<{ txHash: Hex; leafIndex: number }>(`${this.opts.sponsorUrl}/v1/withdraw`, {
      proof,
      request: {
        root,
        nullifierHash: spent.nullifierHash,
        withdrawnValue: step.withdrawn,
        newCommitment,
        recipient,
        relayer: sponsor.address,
        fee,
        encryptedNote,
      },
    });
    step.note.spent = true;
    this.persist();
    await this.syncUnlocked();
    return res.txHash;
  }

  private allocateNoteIndex(): number {
    const i = this.state.nextNoteIndex++;
    this.persist();
    return i;
  }

  private async syncUnlocked(): Promise<void> {
    const { publicClient: client, deployment: d } = this.opts;
    const chunk = this.opts.logChunkSize ?? 5000n;
    const latest = await client.getBlockNumber();
    let from = BigInt(this.state.lastSyncedBlock) + 1n;
    while (from <= latest) {
      const to = from + chunk - 1n < latest ? from + chunk - 1n : latest;
      const [deposits, withdrawals] = await Promise.all([
        client.getContractEvents({ address: d.pool, abi: ZeroupPool.abi, eventName: "Deposit", fromBlock: from, toBlock: to }),
        client.getContractEvents({ address: d.pool, abi: ZeroupPool.abi, eventName: "Withdrawal", fromBlock: from, toBlock: to }),
      ]);
      const leaves = [
        ...deposits.map((e) => ({
          leafIndex: Number(e.args.leafIndex),
          commitment: e.args.commitment!,
          memo: e.args.encryptedNote!,
          nullifierHash: undefined as bigint | undefined,
          tx: e.transactionHash,
        })),
        ...withdrawals.map((e) => ({
          leafIndex: Number(e.args.leafIndex),
          commitment: e.args.newCommitment!,
          memo: e.args.encryptedNote!,
          nullifierHash: e.args.nullifierHash,
          tx: e.transactionHash,
        })),
      ].sort((a, b) => a.leafIndex - b.leafIndex);

      for (const leaf of leaves) {
        if (leaf.leafIndex < this.state.leaves.length) continue;
        if (leaf.leafIndex !== this.state.leaves.length) {
          throw new Error(`leaf gap: expected ${this.state.leaves.length}, got ${leaf.leafIndex}`);
        }
        this.state.leaves.push(leaf.commitment.toString());
        this.tree.insert(leaf.commitment);
        if (leaf.nullifierHash !== undefined) this.markSpent(leaf.nullifierHash);
        this.ingestMemo(leaf.memo, leaf.commitment, leaf.leafIndex, leaf.tx);
      }
      this.state.lastSyncedBlock = to.toString();
      from = to + 1n;
    }
    this.persist();
  }

  private markSpent(nullifierHash: bigint): void {
    const h = nullifierHash.toString();
    for (const n of this.state.notes) if (n.nullifierHash === h) n.spent = true;
  }

  private ingestMemo(data: Hex, commitment: bigint, leafIndex: number, tx: Hex): void {
    const memo = decryptMemo(this.opts.keys.viewingKey, data);
    if (!memo) return;
    const s = noteSecrets(this.opts.keys, memo.noteIndex);
    // Only accept notes whose commitment we can reproduce from our own keys.
    if (poseidon([BigInt(memo.value), s.precommitment]) !== commitment) return;
    this.state.nextNoteIndex = Math.max(this.state.nextNoteIndex, memo.noteIndex + 1);
    if (!this.state.notes.some((n) => n.noteIndex === memo.noteIndex) && BigInt(memo.value) > 0n) {
      this.state.notes.push({
        noteIndex: memo.noteIndex,
        leafIndex,
        value: memo.value,
        commitment: commitment.toString(),
        nullifierHash: s.nullifierHash.toString(),
        spent: false,
        source: memo.kind === "deposit" ? "deposit" : "change",
        createdAt: memo.ts,
      });
    }
    if (memo.kind === "payment") {
      this.state.nextPayerIndex = Math.max(this.state.nextPayerIndex, memo.payerIndex + 1);
      // Recovery from seed: rebuild payment history from on-chain memos.
      if (!this.state.payments.some((p) => p.payerIndex === memo.payerIndex)) {
        this.state.payments.push({
          id: randomUUID(),
          ts: memo.ts,
          resource: memo.resource,
          network: this.network,
          payTo: memo.payTo,
          amount: memo.amount,
          fee: memo.fee,
          payer: memo.payer,
          payerIndex: memo.payerIndex,
          withdrawTxs: [tx],
          status: "funded",
        });
      }
    }
  }

  private persist(): void {
    this.store.save(this.state);
  }

  private log(msg: string): void {
    this.opts.log?.(msg);
  }
}
