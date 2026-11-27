# Benchmark: what really moves on chain

This measures one thing: **when a seller loses the response after a payment settled, how much money moves, and does the buyer get what they paid for?**

It buys 40 items one after another from a seller that sometimes drops the connection (or answers 503) right after the payment settled. The buyer retries the way most agent code does: up to 2 more tries on a dropped connection or a 5xx, never on a 402. It does this twice, once with the stock `@x402/fetch` wrapper and once with `x402-once`, with the same wallet, the same seller and the same bad luck. Then it counts the `Transfer` events on the chain. The chain is the judge, not the seller's log (the run checks that the two agree).

Everything on the seller side is the official x402 code: `x402ResourceServer` and `x402HTTPResourceServer` for the seller, `x402Facilitator` with the official EVM scheme for the facilitator, `@x402/evm` for the buyer's signatures. Only the fault is added: the seller closes the socket after `processSettlement` succeeded.

## Two environments

| | Local | Base Sepolia |
|---|---|---|
| Chain | anvil, chain id 31337, 1-second blocks | Base Sepolia (84532) |
| Token | `TestUSDC.sol`, a minimal EIP-3009 token with USDC's domain (name "USDC", version "2") | Circle's test USDC |
| Facilitator | the official facilitator code, run locally | the public one at x402.org (it pays the gas) |
| Needs | `anvil` (Foundry) | a wallet with test USDC (free) |
| Command | `node bench/run.mjs --network local` | `node bench/wallet.mjs`, fund it, then `node bench/run.mjs --network base-sepolia` |

Results land in `bench/results/<name>.json` and `.md`.

## Running on Base Sepolia

1. `node bench/wallet.mjs` creates `bench/.wallet.json` (git-ignored, mode 0600) with two throwaway keys and prints the buyer and seller addresses. It never prints a key.
2. Get test USDC for the buyer address at https://faucet.circle.com (choose Base Sepolia, token USDC). The buyer needs no ETH; the facilitator pays gas. The run costs well under 0.2 USDC of test tokens.
3. `node bench/run.mjs --network base-sepolia --purchases 20 --out base-sepolia`

Test tokens have no value. Do not put real funds in `.wallet.json`.

## Scenarios

1. **No faults.** Sanity check: both clients should pay exactly once per item.
2. **Faults, plain seller.** 30% of paid requests hit a fault. The seller does what the official middleware does: it does not remember payments, so a re-sent payment is refused. This is the common case today.
3. **Faults, replaying seller.** Same faults, but the seller remembers each payment nonce and serves the same answer again instead of charging.

Faults are picked from a hash of (seed, URL, how many paid requests that URL has had), so both clients meet the same bad luck for the same item.

## What the columns mean

- **Transfers on chain**: `Transfer` events to the seller's address during that row.
- **Items charged twice**: items that were paid for two or more times.
- **Extra transfers**: transfers beyond one per item. This is wasted money.
- **Paid, not delivered**: items whose payment settled but whose data never reached the buyer.
- **…and told so**: of those, how many the client reported as `SettledWithoutDeliveryError`, rather than leaving the caller with a bare 402. The next column says how many of those named the transaction (that needs a log query the RPC may refuse; the resolver retries with a narrow window).

## Reading the rows fairly

- In the replaying-seller row the stock client cannot benefit from replay (it never re-sends a nonce), so that row shows what a replaying seller makes possible for `x402-once`, not a head-to-head measurement.
- In the plain-seller row a client that re-sends can never get the data back after a lost response, because the seller refuses a repeat. The stock client "recovers" only by paying again. Quote both columns: money wasted and items delivered.
- The stock client always runs first in each scenario, so latency figures are indicative only.
- Items-paid and charged-twice come from the seller's log; transfers on chain are independent. The run aborts if the two disagree or if the buyer's balance change does not match the transfers.

## Concurrent calls: `bench/differential.mjs`

This run needs no chain: `npm run build && node bench/differential.mjs [--identical 1000] [--distinct 500]`. It uses the in-process simulated seller and compares the stock wrapper with `x402-once` on 1000 identical overlapping calls, 500 distinct purchases (a control), a lost response followed by one retry, and two buyers sending the same request with and without `scope`. Output: `bench/results/differential.md`. Settlements here are the simulator's count of distinct authorizations, not transfers on a chain.

## Reading failures on chain

A purchase that did not deliver is one of two things, and `authorizationState(payer, nonce)` on the token tells them apart: `false` means the facilitator never landed a transaction (the authorization is unused and still the buyer's), `true` means the payment settled and only the response was lost. The Base Sepolia rows count failures as "not delivered"; they are settlement failures (`invalid_exact_evm_transaction_failed`, 5 to 8 per 100 on both clients, no money moved), not lost responses.

## Known limits

- The chain runs are sequential purchases only. Concurrent purchases are covered by `bench/differential.mjs` (simulated seller) and the unit tests.
- One fault shape (the connection closes after settlement, or a 503). Slow responses that time out on the buyer's side are not simulated.
- A local chain has instant gas and 1-second blocks. Base Sepolia numbers are the ones to quote.
