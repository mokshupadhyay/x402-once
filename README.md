# x402-once

Pay once for each [x402](https://github.com/x402-foundation/x402) purchase, even when the network lies.

If a response is lost after the seller settled, the stock x402 client signs a second payment with a new nonce, and the seller can settle that one too. `x402-once` saves the signed payment before sending it and sends the same payment again on a retry, so a retry can never become a second charge.

- **One install.** It wraps the `x402Client` you already have. No queue library, no second dependency.
- **Non-custodial.** Your client signs. This package never sees a key.
- **Fails closed.** If it cannot tell whether an old payment settled, it signs nothing and says so.
- **Tested against the bug.** Random faults, clock jumps and retries never charge a purchase twice. The same test finds a double charge in the stock client every time. [Mutation evidence](docs/MUTATION_EVIDENCE.md): 22 of 22 deliberate breaks are caught.

> **Status: 0.0.0, not published.** The evidence so far comes from a simulated seller. See [What is and is not proven](#what-is-and-is-not-proven).

## The bug

```
1. client asks for /report            -> 402, price 0.01 USDC
2. client signs payment A (nonce a)   -> sends it
3. seller settles A on chain          -> response is lost (timeout, dropped connection, 5xx)
4. the app retries /report            -> 402 again
5. client signs payment B (nonce b)   -> seller settles B too
```

One purchase, two settlements. The reference client mints a fresh nonce for every 402 it sees ([x402 #3438](https://github.com/x402-foundation/x402/issues/3438)), and the protocol has no idempotency key ([#4198](https://github.com/x402-foundation/x402/issues/4198), [#786](https://github.com/x402-foundation/x402/issues/786)). A [buyer-side measurement on Base mainnet](https://github.com/x402-foundation/x402/issues/4367) retried 10 sellers after a dropped connection and 5 settled twice.

## Use

```ts
import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { createPaidFetch, evmAuthorizationResolver } from 'x402-once';

const client = x402Client.fromConfig({
  schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(signer) }],
});

const paidFetch = createPaidFetch({
  client,
  // Optional but recommended: lets it prove an old payment never settled before signing a new one.
  resolver: evmAuthorizationResolver({ rpcUrls: { 'eip155:8453': 'https://mainnet.base.org' } }),
});

const response = await paidFetch('https://api.example.com/report'); // use it like fetch
```

Retry the same call as often as you like. The same signed payment goes out each time.

### What a retry does

| The saved payment is... | A retry... |
|---|---|
| still valid | sends the same signed payment again |
| past its deadline, and the chain says it was **never used** | signs a new payment (safe: the old one can no longer settle) |
| past its deadline, and the chain says it **was used** | throws `SettledWithoutDeliveryError`: you paid, the resource never arrived. Ask the seller; do not pay again |
| still valid, but the seller **refuses** the re-sent payment and the chain says it was **used** (needs a `resolver`) | throws `SettledWithoutDeliveryError` at once, with the transaction hash when the RPC can find it. Without a `resolver` you get the seller's 402 back |
| past its deadline, but only by less than `expirySkewMs` (30 s) | throws `UnresolvedPaymentError`; retry a little later |
| past its deadline, and nobody can tell | throws `UnresolvedPaymentError` and signs nothing |

If another process finishes the same purchase while your call is waiting, you get `PurchaseSettledElsewhereError` and nothing is signed. A key you choose is bound to the request: the same key on a different URL or body is a different purchase, and an empty key counts as no key.

`forget` is for after you have dealt with an error. Calling it on a payment that is still valid lets the next call sign a new one, which can pay twice.

After a delivered purchase, the next identical call is a **new** purchase. To make a key mean "this exact purchase, ever", pass your own: an `Idempotency-Key` header or the `intentKey` option. Then a second call throws `AlreadySettledError`. To buy again on purpose after an error, call `paidFetch.forget(error.record.intent)`.

### Stores

`MemoryPaymentStore` is the default. It protects retries inside one process and forgets everything on restart. **For crashes and restarts, pass a durable `store`** (anything that implements `get` and an atomic `compareAndSet`). A saved record holds a signed authorization: protect it like a session token.

For a single machine, use the file store. It writes each record to disk before returning (temp file, fsync, rename) and takes a per-purchase lock, so a restart or a second process on the same machine sees the same payments:

```ts
import { FilePaymentStore } from 'x402-once/node';

const paidFetch = createPaidFetch({ client, store: new FilePaymentStore({ directory: './.x402-once' }) });
```

A corrupt record file is an error, never "nothing was paid". It does not work across machines sharing a network drive; for that, implement `PaymentStore` over a database with a conditional update. Files are created readable by the owner only.

### Custom resolvers

`resolver` may return `'settled' | 'unsettled' | 'unknown'`, or `{ verdict, transaction? }`. The transaction, when you can supply it, ends up in the error and the saved record. Anything else, or a throw, counts as `unknown`. `evmAuthorizationResolver` returns the object form; it answers `unsettled` only when the latest block's own timestamp is past the authorization's `validBefore` (your clock and a lagging RPC node are not trusted for that), and it looks up the transaction in the last `lookbackBlocks` (default 5000) blocks and still answers if the RPC refuses the range.

## Test your own client

`x402-once/testing` is a fault-injecting seller that runs in-process, with no network and no wallet. It counts distinct settlements, which is the only way this bug shows up.

```ts
import { createSimulatedMerchant, createFakeClient, scriptedFaults } from 'x402-once/testing';

const seller = createSimulatedMerchant({ faults: scriptedFaults('drop-after-settle') });
// ...call seller.fetch through your client, retry, then:
seller.settlementCount; // 2 means you paid twice
```

Faults: `drop-before-settle`, `error-before-settle`, `drop-after-settle`, `error-after-settle`, `fresh-402-after-settle`. Use `randomFaults(seed, weights)` for reproducible random runs.

## What is and is not proven

**Proven (64 tests; the property tests run a few hundred random programs by default, and `RUNS=30000 npx vitest --run tests/properties.test.ts --testTimeout=300000` passes):**
- No purchase is paid twice under random faults, clock jumps and retries. The identical test finds double charges in the stock `@x402/fetch` wrapper.
- The deadline is read from the real signed EIP-3009 authorization (checked with the official `@x402/evm` scheme and a throwaway key, no network).
- The property tests found a real bug in the first design (a payment that settled but was never delivered could be bought again). It is fixed and has a regression test.

**Not proven yet:**
- Behaviour on a public testnet. The benchmark in [bench/](bench/README.md) runs the official seller and facilitator code on a local chain (40 purchases, 30% of paid requests lose their response; seed `bench-1`); the same run on **Base Sepolia** with the public x402.org facilitator is below.

| Seller | Client | Delivered | Transfers on chain | Items charged twice | Wasted transfers |
|---|---|---|---|---|---|
| plain (like the official middleware) | stock `@x402/fetch` | 38/40 | 51 | 9 | 11 |
| plain | `x402-once` | 31/40, the other 9 reported as `SettledWithoutDeliveryError` with the transaction | 40 | 0 | 0 |
| replays a settled payment | stock | 38/40 | 51 | 9 | 11 |
| replays a settled payment | `x402-once` | 40/40 | 40 | 0 | 0 |

The trade is plain: with a seller that cannot replay, `x402-once` will not pay twice to get the data back, so some items are paid for and not delivered, and it says so. 

**Base Sepolia** (20 purchases per row, same fault schedule, real USDC, public facilitator). Two full runs:

| Seller | Client | Delivered (run 1 / run 2) | Transfers on chain (run 1 / run 2) | Items settled (run 1 / run 2) | Extra transfers |
|---|---|---|---|---|---|
| plain | stock `@x402/fetch` | 19 / 16 | 28 / 23 | 20 / 18 | 8 / 5 |
| plain | `x402-once` | 14 / 13 | 20 / 19 | 20 / 19 | 0 / 0 |
| replays a settled payment | stock | 17 / 17 | 26 / 26 | 18 / 19 | 8 / 7 |
| replays a settled payment | `x402-once` | 18 / 19 | 18 / 19 | 18 / 19 | 0 / 0 |

- Across both runs the stock client paid 5 to 8 extra times per fault scenario. `x402-once` never paid twice.
- With a plain seller, the items `x402-once` did not receive (6 and 7 per run) were all reported as `SettledWithoutDeliveryError`.
- Some items settled for neither client. Run 2 recorded why: the **public facilitator itself** intermittently failed to settle (`invalid_exact_evm_transaction_failed`: its own transaction nonce was behind, or the RPC rejected the transaction). That is outside both clients and hit them at random, 1 to 3 times per row. This is also why delivered counts vary between runs.
- Run 2 also shows what `x402-once` relies on: on a re-sent payment the facilitator answers `invalid_exact_evm_nonce_already_used`, and the chain confirms the payment was used.
- Small sample, one network, one seller. Treat the percentages loosely; the extra-transfer counts are the solid part.
- Solana (`svm`) payments. Only the EVM `exact` scheme is covered; other schemes fall back to the seller's `maxTimeoutSeconds` and have no resolver, so they fail closed.
- x402 v1 payloads, axios, and the client's recovery hooks.
- Two machines sharing one store. `FilePaymentStore` is for one machine.

**Cannot fix, by design:** a seller or facilitator that settles the same payment twice ([#786](https://github.com/x402-foundation/x402/issues/786)), and sellers that answer a replay with a refusal instead of the resource (the buyer is charged once but gets nothing; the error says so).

## Design

See [docs/DESIGN.md](docs/DESIGN.md). Short version: save before send, reuse while valid, ask the chain when expired, fail closed when unsure.

## Licence

MIT
