# Security and threat model

**Status: unaudited development software. Testnets only.**

## What Zeroup hides, and from whom

| Observer | Sees | Does not see |
| --- | --- | --- |
| Merchant / facilitator | the one-time payer, amount, time, resource | the funding wallet, other payments by the same user |
| Chain observer | deposits (funding wallet, amount), withdrawals (one-time recipient, amount), payments | which deposit funded which withdrawal |
| Sponsor | the same as a chain observer, plus caller IP | note ownership (proofs are zero-knowledge) |
| Viewing-key holder | the full history and balance | nothing it could use to spend |

Privacy here means **unlinkability, not invisibility**. It is weakened by:

- **Small anonymity sets**: few deposits in the pool.
- **Unique amounts and timing**: a 7.3141 USDC deposit followed by an exit of the same amount links the two.
- **Network metadata**: IP addresses, API keys, request timing. Route traffic through Tor or another relay. Zeroup does not do this yet.
- **The withdraw-then-pay pattern**: it shows that the payer was funded by the pool, but not by whom.

## Before mainnet

1. **Trusted setup.** `zk/withdraw.zkey` comes from a single-party phase 2 (and possibly phase 1). Whoever ran the setup could forge proofs and drain the pool. Run a public multi-party phase-2 ceremony on the Hermez or PSE phase-1 file, and publish the transcript.
2. **Audits** of the circuit, `ZeroupPool`, the sponsor and the facilitator. Then a bug bounty.
3. **Screening provider.** Wire `Screener` to a sanctions/stolen-funds feed run by a compliance multisig. Consider association-set proofs (Privacy Pools v2) instead of, or as well as, deposit screening.
4. **Legal opinion** on money transmission in each launch market. The sponsor and facilitator only submit user-signed or proof-bound transfers and never custody funds, but get counsel to confirm that.
5. **Operations.** Fund the sponsor and facilitator hot wallets from a treasury with low balances and alerting. Put them behind TLS and a WAF, and run several RPC providers.
6. **Key UX.** Move to passkey-protected seeds with guardian recovery. The current keystore uses scrypt (N=2^15) with XChaCha20-Poly1305.

## Service hardening already in place

- **Wallet daemon:** rejects unknown `Host` headers (DNS rebinding) and non-JSON POSTs (cross-site forms). It refuses to bind beyond localhost without `WALLET_API_TOKEN`.
- **Facilitator:** `FACILITATOR_API_KEY` restricts `/verify` and `/settle` to your merchants. Without it, anyone can use it as a free gas station for USDC transfers.
- **Sponsor:** enforces a minimum deposit, per-address and per-IP rate limits, and an in-flight guard per nullifier.
- **Signatures:** the sponsor and facilitator accept 65-byte and compact (EIP-2098) signatures.

## Known limitations

- The sponsor pays deposit gas without being reimbursed; it is rate-limited per address.
- If a payment is funded but never settles (merchant down, payment rejected, partial multi-note failure), the money sits in that payment's one-time account. `zeroup reclaim` (or the dashboard's "Reclaim unsettled" button) moves it back into the pool once the signed authorization has expired. Amounts below the sponsor's minimum deposit stay put.
- Wallet sync scans `eth_getLogs` from the deployment block. Large deployments need an indexer. A wrong leaf set from an indexer cannot cause a loss: the pool rejects any root it never had.
