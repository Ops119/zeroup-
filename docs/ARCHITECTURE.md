# Architecture

## Payment flow

1. The agent calls an API and gets `402` with a `PAYMENT-REQUIRED` header (x402 v2, base64 JSON).
2. `createPrivateFetch` picks an `exact` option on the wallet's network and asset.
3. `ZeroupWallet.pay` checks the spend policy: per-payment limit, rolling 24h budget, host allowlist.
4. The wallet derives payer account `i` from the spending key and picks the smallest note that covers `amount + fee`. If no single note does, it splits the payment across several notes.
5. For each note it builds a Groth16 proof (about 1s) and posts it to the **sponsor**. The sponsor checks the proof, the root, the nullifier and the screening list off-chain, simulates, then submits `ZeroupPool.withdraw`. The pool sends `amount` to the payer and `fee` to the sponsor, and inserts the change commitment.
6. The payer signs EIP-3009 `TransferWithAuthorization` to `payTo`. The client retries the request with `PAYMENT-SIGNATURE`.
7. The merchant paywall (`paid()`) runs facilitator `/verify`, then the handler, then `/settle`, and returns `PAYMENT-RESPONSE`.

## Notes and keys

```
seed (BIP-39, 24 words)
 ├─ spendingKey ─┬─ nullifier_i, secret_i          (note i)
 │               └─ payerKey_j                     (one-time account j)
 ├─ viewingKey   ── XChaCha20-Poly1305 memos, encrypted local state
 └─ stealth spend/view keys ── ERC-5564 meta-address
```

- `precommitment = Poseidon(nullifier, secret)`. The pool computes `commitment = Poseidon(value, precommitment)` itself at deposit, so a depositor cannot mint value.
- `nullifierHash = Poseidon(nullifier)` is revealed when the note is spent.
- Every deposit and withdrawal carries an **encrypted memo** of note index, value and payment details, padded to 128-byte buckets. The memo serves two purposes:
  - **Recovery**: a fresh install rebuilds notes and payment history from the seed alone.
  - **Audit**: a viewing-key holder reads history and balance, but cannot derive nullifiers, so cannot spend.

## Binding and replay protection

| Threat | Defence |
| --- | --- |
| Relayer redirects a withdrawal or raises its fee | The `context` public input is `keccak(chainId, pool, recipient, relayer, fee, keccak(memo)) mod p` |
| Front-running a gasless deposit with another note | The EIP-3009 nonce must equal `keccak(chainId, pool, precommitment, keccak(memo))` |
| Double spend | `nullifierSpent` mapping |
| Stale root | 64-root history; the sponsor returns 409 "resync" |
| `withdrawnValue > value` wrap-around | 128-bit range checks on `remaining` and `withdrawnValue` |
| x402 payload replay | EIP-3009 nonce state, plus an in-flight set in the facilitator |
| Two processes reusing note indices | Exclusive wallet lock file |

## Services

| Service | Port | Holds keys for | Endpoints |
| --- | --- | --- | --- |
| Sponsor | 4010 | gas wallet | `GET /v1/info`, `POST /v1/deposit`, `POST /v1/withdraw` |
| Facilitator | 4020 | gas wallet | `GET /supported`, `POST /verify`, `POST /settle` |
| Demo merchant | 4030 | none | `/api/weather`, `/api/quote/:symbol`, `/api/report`, `/merchant/ledger` |
| Wallet daemon | 4040 | user keystore | `/api/status`, `/api/deposit`, `/api/fetch`, `/api/exit`, `/api/viewing-key`, `/api/audit`, dashboard |

The sponsor and facilitator never hold user funds. Each one serialises its own transactions, rate-limits per IP, and the sponsor also rate-limits deposits per funding address.

## Rebuilding the circuit

`npm run build:circuits` compiles `circuits/withdraw.circom` (13,143 constraints) and runs the Groth16 setup. It then rewrites `contracts/Groth16Verifier.sol` and `zk/`, and you should follow it with `npm run build`. Phase 1 uses the Hermez Powers of Tau when it can be downloaded. Otherwise it generates a local one, which is for development only.
