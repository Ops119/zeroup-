<p align="center"><img src="web/brand/zeroup-logo.png" alt="Zeroup" width="240"></p>

# Zeroup

Zeroup is a non-custodial smart wallet that pays [x402](https://github.com/coinbase/x402) invoices privately, with every fee sponsored. Apps and AI agents pay for APIs, and the payments can't be traced back to the wallet that funded them.

This repository is the **Phase 0/1 MVP on EVM** (local Hardhat and Base Sepolia). It runs end to end:

- **ZeroupPool**: a shielded USDC pool. It holds a Poseidon Merkle tree of note commitments, and a Groth16 proof spends a note and re-commits the change.
- **Gasless everything**: deposits use EIP-3009 `receiveWithAuthorization`, submitted by a sponsor. Withdrawals are proof-authorised and the sponsor is paid a fee bound into the proof. Payments use x402 `exact` (EIP-3009 `transferWithAuthorization`), submitted by the facilitator.
- **One-time payer per payment**: each x402 invoice is paid from a fresh account. That account is funded from the pool moments earlier and has no history.
- **Zeroup facilitator**: x402 v2 `/verify`, `/settle` and `/supported` for `exact` on EVM.
- **Agent wallet**: key engine (spending, viewing and ERC-5564 stealth keys from one recovery phrase), encrypted state, spend policy, `fetch` that auto-pays HTTP 402, a CLI, and a local dashboard.
- **Compliance from day one**: screening list enforced by the pool, sponsor and facilitator. Each user has a viewing key that gives an auditor full history but no ability to spend.

```
 public wallet ──(signed EIP-3009, sponsor pays gas)──▶ ZeroupPool ──(ZK proof, sponsor pays gas)──▶ one-time payer
                                                         shielded                                        │ x402 exact (EIP-3009)
                                                                                                         ▼  facilitator pays gas
                                                                                                      merchant
```

A merchant, the facilitator or a chain watcher sees only the one-time payer. The pool breaks the link back to the funding wallet.

## Quick start

Requires Node 20+.

```bash
npm install
npm run build        # compile contracts and export ABIs (zk/ keys are committed)
npm run demo         # full scripted run on a throwaway local chain
npm test             # unit + end-to-end tests, including adversarial cases
npm run dev          # local chain + all services + dashboard at http://127.0.0.1:4040
```

`npm run demo` deploys everything and makes a 5 USDC gasless deposit. It then has an agent call three paid endpoints, and prints what the merchant saw next to what the viewing-key auditor sees:

```
Merchant ledger (payer addresses):
  0x2057…81B5  0.01 USDC  /api/weather
  0xC983…97dE  0.02 USDC  /api/quote/ETH
  0xb6bc…5921  0.05 USDC  /api/report
every payment from a different address: true
any payer equals the funding wallet: false
Auditor with the viewing key only (cannot spend):
  deposit  5 USDC     from 0x90F7…b906
  payment  0.01 USDC  to 0x15d3…6A65 for /api/weather
  ...
```

### CLI (with `npm run dev` stopped, or pointed at another network)

```bash
npm run zeroup -- init                       # encrypted keystore + recovery phrase
npm run zeroup -- deposit 10                 # gasless, signed by FUNDER_PRIVATE_KEY
npm run zeroup -- pay "http://127.0.0.1:4030/api/weather?city=Oslo"
npm run zeroup -- status
npm run zeroup -- exit 0xYourAddress 2.5
npm run zeroup -- audit $(npm run -s zeroup -- viewing-key)
```

Only one process can hold a wallet at a time; the CLI says so if the dashboard has it open.

### Use it from your own agent

```ts
const wallet = await ZeroupWallet.open({ keys, deployment, publicClient, sponsorUrl, stateFile });
const privateFetch = createPrivateFetch(wallet);
const { response, payment } = await privateFetch("https://api.example.com/paid");
```

### Charge for your own API

```ts
app.get("/premium", paid(
  { facilitatorUrl, network: "eip155:84532", asset: USDC, assetName: "USDC", assetVersion: "2", payTo },
  { price: "10000", description: "Premium data", handler: (req) => ({ ... }) },
));
```

## Base Sepolia

```bash
cp .env.example .env              # fill in keys; sponsor and facilitator need Base Sepolia ETH
npm run deploy                    # pool against native USDC 0x036C…CF7e -> deployments/base-sepolia.json
npm run serve -- sponsor          # each in its own process or container
npm run serve -- facilitator
npm run serve -- merchant
npm run serve -- wallet           # dashboard; FUNDER_PRIVATE_KEY holds testnet USDC
```

A Docker image runs any of the services: `docker build -t zeroup . && docker run --env-file .env -p 4010:4010 zeroup sponsor`.

## Layout

| Path | What |
| --- | --- |
| `circuits/withdraw.circom` | Spend a note, release `withdrawnValue`, re-commit the change; binds recipient, relayer, fee and memo |
| `contracts/ZeroupPool.sol` | Shielded pool, incremental Poseidon tree (depth 20, 64-root history), gasless deposit |
| `contracts/Screener.sol` | Screening list (compliance multisig) |
| `contracts/MockUSDC.sol` | Local USDC with the same EIP-3009 surface and EIP-712 domain |
| `src/core` | Poseidon, Merkle tree, key engine, ERC-5564 stealth, encrypted memos, prover, x402 types |
| `src/wallet` | Wallet, x402 auto-pay fetch, spend policy, viewing-key auditor, keystore |
| `src/services` | Sponsor, facilitator, merchant paywall, wallet daemon |
| `zk/` | Circuit wasm and Groth16 keys (**development setup**, see below) |

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/SECURITY.md](docs/SECURITY.md)

## Status: what this MVP is and isn't

These are built and tested: the EVM payment path, the ZK pool, the sponsor, the facilitator, the wallet, the CLI and the dashboard.

These are **not** built yet. They are all from the build plan:

- **Solana.** The Kora fee payer, Squads/Swig accounts and Privacy Cash integration are not here. The wallet and facilitator are split by network, so an SVM adapter slots in beside them.
- **ERC-4337 / EIP-7702 accounts and passkeys.** One-time payers are plain EOAs. They never need gas, because EIP-3009 lets the facilitator submit for them. Smart accounts become relevant for the user's main wallet, session keys and recovery.
- **Association-set proofs** (Privacy Pools style). Instead there is deposit screening, plus "anyone can exit" to a public address.
- **Network-level privacy** (Tor/Nym relay), batched change and fixed-denomination top-ups.
- **Mainnet readiness.** The circuit keys come from a single-party development setup, and nothing has been audited. Do not put real funds in it. Read [docs/SECURITY.md](docs/SECURITY.md) and get legal advice on money transmission before any mainnet launch.
