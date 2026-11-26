# x402-once

Pay once for each [x402](https://github.com/x402-foundation/x402) purchase, even when the network lies.

If a response is lost after the seller settled, the stock x402 client signs a second payment with a new nonce, and the seller can settle that one too. `x402-once` saves the signed payment before sending it and sends the same payment again on a retry, so a retry can never become a second charge.

- **One install.** It wraps the `x402Client` you already have. No queue library, no second dependency.
- **Non-custodial.** Your client signs. This package never sees a key.
- **Fails closed.** If it cannot tell whether an old payment settled, it signs nothing and says so.
- **Tested against the bug.** Random faults, clock jumps and retries never charge a purchase twice. The same test finds a double charge in the stock client every time. [Mutation evidence](docs/MUTATION_EVIDENCE.md): 9 of 9 deliberate breaks are caught.

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
| past its deadline, and nobody can tell | throws `UnresolvedPaymentError` and signs nothing |

After a delivered purchase, the next identical call is a **new** purchase. To make a key mean "this exact purchase, ever", pass your own: an `Idempotency-Key` header or the `intentKey` option. Then a second call throws `AlreadySettledError`. To buy again on purpose after an error, call `paidFetch.forget(error.record.intent)`.

### Stores

`MemoryPaymentStore` is the default. It protects retries inside one process and forgets everything on restart. **For crashes and restarts, pass a durable `store`** (anything that implements `get` and an atomic `compareAndSet`). A saved record holds a signed authorization: protect it like a session token.

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

**Proven (simulated seller, 36 tests, 30,000-run property check):**
- No purchase is paid twice under random faults, clock jumps and retries. The identical test finds double charges in the stock `@x402/fetch` wrapper.
- The deadline is read from the real signed EIP-3009 authorization (checked with the official `@x402/evm` scheme and a throwaway key, no network).
- The property tests found a real bug in the first design (a payment that settled but was never delivered could be bought again). It is fixed and has a regression test.

**Not proven yet:**
- Behaviour against a real facilitator on a live chain. A Base Sepolia run is planned.
- Solana (`svm`) payments. Only the EVM `exact` scheme is covered; other schemes fall back to the seller's `maxTimeoutSeconds` and have no resolver, so they fail closed.
- x402 v1 payloads, axios, and the client's recovery hooks.
- A durable store: only the in-memory one ships.

**Cannot fix, by design:** a seller or facilitator that settles the same payment twice ([#786](https://github.com/x402-foundation/x402/issues/786)), and sellers that answer a replay with a refusal instead of the resource (the buyer is charged once but gets nothing; the error says so).

## Design

See [docs/DESIGN.md](docs/DESIGN.md). Short version: save before send, reuse while valid, ask the chain when expired, fail closed when unsure.

## Licence

MIT
