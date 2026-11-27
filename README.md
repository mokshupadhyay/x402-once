# x402-once

Pay once for each [x402](https://github.com/x402-foundation/x402) purchase, even when the network lies.

If a response is lost after the seller settled, the stock x402 client signs a second payment with a new nonce, and the seller can settle that one too. `x402-once` saves the signed payment before sending it and sends the same payment again on a retry, so a retry does not become a second charge. That holds under the conditions listed in [What is and is not proven](#what-is-and-is-not-proven) and [the threat model](docs/OPERATIONS.md#threat-model): a client that has not been tampered with, a store that keeps the record, and an RPC you trust to say when a payment can no longer settle.

- **One install.** It wraps the `x402Client` you already have. No queue library, no second dependency.
- **Non-custodial.** Your client signs. This package never sees a key.
- **Fails closed.** If it cannot tell whether an old payment settled, it signs nothing and says so.
- **Tested against the bug.** In the simulated and benchmark tests, random faults, clock jumps and retries never charged a purchase twice. The same test finds a double charge in the stock client every time. [Mutation evidence](docs/MUTATION_EVIDENCE.md): 69 of 69 hand-picked deliberate breaks of the source are caught by the tests (these are the author's own tests and mutations, not an outside audit).

> **Status: 0.x, not published yet.** Minor versions may change the API. Evidence comes from a simulated seller (unit and property tests) and from the official seller and facilitator code on a local chain and on Base Sepolia, with the lost responses injected by a proxy in front of the seller. See [What is and is not proven](#what-is-and-is-not-proven).

**Use it when** your buyer (an agent, a script, a backend) retries paid calls and a second charge would hurt. **Do not rely on it when:** the seller or facilitator itself settles one payment twice ([#786](https://github.com/x402-foundation/x402/issues/786)); you need the data more than you need to avoid a second payment and your seller cannot replay a settled payment (you will get `SettledWithoutDeliveryError` instead of the data); you run several machines against one store (the file store is for one machine); you pay on Solana, x402 v1 or through axios (not covered: it fails closed).

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
import { privateKeyToAccount } from 'viem/accounts';
import { createPaidFetch, evmAuthorizationResolver } from 'x402-once';

const signer = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY as `0x${string}`);
const client = x402Client.fromConfig({
  schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(signer) }],
});

const paidFetch = createPaidFetch({
  client,
  // Optional but recommended: lets it prove an old payment never settled before signing a new one.
  // Use two or more independent providers: "never settled" is only believed when all of them agree.
  resolver: evmAuthorizationResolver({
    rpcUrls: { 'eip155:8453': ['https://mainnet.base.org', 'https://base-rpc.example-provider.com'] },
    minProviders: 2,
  }),
  limits: { networks: ['eip155:8453'], maxAmount: '1000000' }, // at most 1 USDC per purchase
});

const response = await paidFetch('https://api.example.com/report'); // use it like fetch
```

Retry the same call as often as you like. The same signed payment goes out each time.

### Try it offline in 30 seconds

No wallet, no network. The seller loses the response after it settled, then replays the answer:

```ts
import { createPaidFetch } from 'x402-once';
import { createSimulatedMerchant, createFakeClient, scriptedFaults } from 'x402-once/testing';

const seller = createSimulatedMerchant({ faults: scriptedFaults('drop-after-settle'), serveOnReplay: true });
const paidFetch = createPaidFetch({ client: createFakeClient('eip155:84532'), fetch: seller.fetch });

await paidFetch('https://seller.test/report').catch(() => 'response lost');
const retry = await paidFetch('https://seller.test/report');
console.log(retry.status, seller.settlementCount); // 200 1  (the stock client would print 200 2)
```

With a seller that cannot replay (`serveOnReplay: false`, like the official middleware today), the retry gets the seller's 402 back, or `SettledWithoutDeliveryError` if you configured a `resolver`. You are charged once either way.

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

`MemoryPaymentStore` is the default. It protects retries inside one process and forgets everything on restart. **For crashes and restarts, pass a durable `store`** (anything that implements `get` and an atomic `compareAndSet`). A saved record holds a signed authorization: see [Security](#security).

For a single machine, use the file store. It writes each record to disk before returning (temp file, fsync, rename) and takes a per-purchase lock, so a restart or a second process on the same machine sees the same payments:

```ts
import { FilePaymentStore } from 'x402-once/node';

const paidFetch = createPaidFetch({ client, store: new FilePaymentStore({ directory: './.x402-once' }) });
```

A corrupt record file is an error, never "nothing was paid". It does not work across machines sharing a network drive; for that, implement `PaymentStore` over a database with a conditional update. Files are created readable by the owner only.

### Custom resolvers

`resolver` may return `'settled' | 'unsettled' | 'unknown'`, or `{ verdict, transaction? }`. The transaction, when you can supply it, ends up in the error and the saved record. Anything else, or a throw, counts as `unknown`. `evmAuthorizationResolver` returns the object form; it answers `unsettled` only when the latest block's own timestamp is past the authorization's `validBefore` (it compares the chain's own clock plus a 60-second margin, not yours; the RPC itself is trusted, so give it several providers and it needs all of them to agree), and it looks up the transaction in the last `lookbackBlocks` (default 5000) blocks and still answers if the RPC refuses the range.

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

**Proven (145 tests; the property tests run a few hundred random programs by default, and `RUNS=30000 npx vitest --run tests/properties.test.ts --testTimeout=300000` passes):**
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

**Base Sepolia** (20 purchases per row, same fault schedule, real USDC, public facilitator). Two full runs of 20:

| Seller | Client | Delivered (run 1 / run 2) | Transfers on chain (run 1 / run 2) | Items settled (run 1 / run 2) | Extra transfers |
|---|---|---|---|---|---|
| plain | stock `@x402/fetch` | 19 / 16 | 28 / 23 | 20 / 18 | 8 / 5 |
| plain | `x402-once` | 14 / 13 | 20 / 19 | 20 / 19 | 0 / 0 |
| replays a settled payment | stock | 17 / 17 | 26 / 26 | 18 / 19 | 8 / 7 |
| replays a settled payment | `x402-once` | 18 / 19 | 18 / 19 | 18 / 19 | 0 / 0 |

**Base Sepolia, 100 purchases per row** (seed `bench-2`, run on the code of commit `20df316`; the later Permit2 changes do not touch the EIP-3009 path):

| Seller | Client | Delivered | Transfers on chain | Items settled | Items charged twice | Extra transfers |
|---|---|---|---|---|---|---|
| no faults | stock `@x402/fetch` | 92/100 | 92 | 92 | 0 | 0 |
| no faults | `x402-once` | 94/100 | 94 | 94 | 0 | 0 |
| plain | stock | 92/100 | 113 | 94 | 17 | 19 |
| plain | `x402-once` | 77/100, the other 19 reported with the transaction | 96 | 96 | 0 | 0 |
| replays a settled payment | stock | 89/100 | 109 | 93 | 14 | 16 |
| replays a settled payment | `x402-once` | 95/100 | 95 | 95 | 0 | 0 |

With no faults at all, the public x402.org facilitator failed to settle 6 to 8 of every 100 payments, for both clients. That is why "delivered" is below 100 in the first rows. Across every Base Sepolia run so far (20, 20 and 100 purchases per row), the stock client paid 5 to 19 extra times per fault row and `x402-once` never paid twice.

- Across both runs the stock client paid 5 to 8 extra times per fault scenario. `x402-once` never paid twice.
- With a plain seller, the 6 items `x402-once` did not receive in each run were all reported as `SettledWithoutDeliveryError`. Put differently: the stock client paid for the same items twice to get them (28 and 23 transfers for 19 and 16 items) while `x402-once` paid 20 and 19 transfers for 14 and 13 items.
- Facilitator failure reasons were recorded in run 2 only; run 1 did not log them.
- Some items settled for neither client. Run 2 recorded why: the **public facilitator itself** intermittently failed to settle (`invalid_exact_evm_transaction_failed`: its own transaction nonce was behind, or the RPC rejected the transaction). That is outside both clients and hit them at random, 1 to 3 times per row. This is also why delivered counts vary between runs.
- Run 2 also shows what `x402-once` relies on: on a re-sent payment the facilitator answers `invalid_exact_evm_nonce_already_used`, and the chain confirms the payment was used.
- Small sample, one network, one seller. Treat the percentages loosely; the extra-transfer counts are the solid part.
- Solana (`svm`) payments. Only EVM payments (EIP-3009 and Permit2) can be inspected and resolved. Other payment types are refused before they are sent, unless you set `allowUninspected`; then there is no resolver and they fail closed after the deadline.
- x402 v1 payloads, axios, and the client's recovery hooks.
- Two machines sharing one store. `FilePaymentStore` is for one machine.

**Cannot fix, by design:** a seller or facilitator that settles the same payment twice ([#786](https://github.com/x402-foundation/x402/issues/786)), and sellers that answer a replay with a refusal instead of the resource (the buyer is charged once but gets nothing; the error says so).

## Security

A saved record contains a **signed payment authorization**. Until its `validBefore` passes, anyone who holds it can submit it. It can only move the signed amount to the signed `payTo`, so the damage is bounded, but treat it like a short-lived session token:

- Keep the store directory out of git (add it to `.gitignore`), out of shared volumes and out of backups you do not control. The file store creates files readable by the owner only.
- Once a purchase is delivered, the record keeps only what is needed to recognise it; the signed payload is not kept.
- Purge old records (see [docs/OPERATIONS.md](docs/OPERATIONS.md)).
- The package never sees your key: your `x402Client` signs.
- **The payment is a bearer instrument.** Anyone who sees the `PAYMENT-SIGNATURE` header before it expires can submit it to the chain themselves. They cannot redirect the money (the payee and amount are signed), but the seller's facilitator would then find the payment already used and the buyer would be charged without delivery. So: only https (this package refuses plain http except localhost), no redirects to another origin, `Cache-Control: no-store` on the paid request. Sellers should answer paid requests with `Cache-Control: private, no-store` and not log the header.
- **Set limits.** The seller chooses the payee, token and price. Pass `limits: { networks, assets, payTo, maxAmount }` so a payment outside what you intended is refused before it is saved or sent. This is in addition to the spend controls of your `x402Client` (by default, only known tokens and a $1 cap per payment).
- **Before anything is sent**, the signed payment is checked against the seller's offer (payee, amount, token, network, nonce, payer, validity window), so a buggy or hostile signer, hook or dependency cannot get a different payment saved or sent. This covers EIP-3009 payments and Permit2 payments (for Permit2 it also pins the `spender`, the contract that pulls the funds, to the official x402 proxy unless you list others in `limits.permit2Spenders`). Payment types it cannot inspect, such as Solana, are **refused before anything is sent** unless you set `allowUninspected: true`.
- **A payer can cancel an authorization on chain** (`cancelAuthorization`). The resolver then reports `settled` with no transaction, because the nonce is used. That is a false "settled": it blocks a retry, it never causes a payment.

## Documentation

- [docs/API.md](docs/API.md): every option, default, error and event.
- [docs/OPERATIONS.md](docs/OPERATIONS.md): what to do on each error, reconciliation, retention, troubleshooting, threat model.
- [docs/QA_PLAN.md](docs/QA_PLAN.md): the test scenarios and release checklist.
- [bench/README.md](bench/README.md): the on-chain benchmark.

## Design

See [docs/DESIGN.md](docs/DESIGN.md). Short version: save before send, reuse while valid, ask the chain when expired, fail closed when unsure.

## Licence

MIT
