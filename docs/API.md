# API reference

```ts
import { createPaidFetch, evmAuthorizationResolver, MemoryPaymentStore } from 'x402-once';
import { FilePaymentStore } from 'x402-once/node';        // one machine, survives restarts
import { createSimulatedMerchant, createFakeClient, scriptedFaults } from 'x402-once/testing';
```

Needs Node 20 or newer (Bun and Deno also work). Peer dependency: `@x402/core` 2.32 up to 3.

## `createPaidFetch(options)` returns `paidFetch`

`paidFetch(input, init?)` works like `fetch`. It also has:

| Member | What it does |
|---|---|
| `paidFetch.forget(intent)` | Gives up on a purchase so the next call starts a new one. Use it only after you have dealt with an error (for example got a refund). Calling it on a payment that is still valid lets the next call sign a new one, which can pay twice. |
| `paidFetch.idle()` | Resolves when bookkeeping after a response was handed over has finished (marking a delivered body complete, removing the signed payment from the record). Await it before a clean exit. |
| `paidFetch.store` | The store in use. |

### Options

| Option | Default | Meaning |
|---|---|---|
| `client` | required | Your configured `x402Client`. It signs; this package never sees a key. |
| `httpClient` | `new x402HTTPClient(client)` | Override the HTTP side of the client. |
| `fetch` | `globalThis.fetch` | The fetch to wrap. |
| `store` | `new MemoryPaymentStore()` | Where signed payments are saved before they are sent. |
| `intentKey` | none | `(request) => string \| undefined`. Choose the purchase key yourself. Falls back to an `Idempotency-Key` header, then to a hash of method, URL and body. An empty string counts as no key. A chosen key is combined with the request's hash, so the same key on a different URL or body is a different purchase. |
| `resolver` | none | Decides whether an old payment settled. Without one the wrapper fails closed after the deadline. Use `evmAuthorizationResolver`. |
| `resolverTimeoutMs` | 15000 | A resolver that takes longer counts as "cannot tell". |
| `limits` | none | `{ networks?, assets?, payTo?, maxAmount?, permit2Spenders? }` (`permit2Spenders` defaults to the official x402 exact Permit2 proxy). A signed payment outside these is refused with `PaymentMismatchError` before it is saved or sent. Strongly recommended. |
| `allowUninspected` | false | Allow payment types this package cannot inspect (for example Solana). Off by default: they are refused before anything is sent. |
| `allowInsecureHttp` | false | Allow sending the signed payment over plain http. Only localhost is allowed without it. |
| `maxValidityMs` | 3600000 | Refuse a signed payment that stays valid longer than this (the seller picks it). Nothing is saved or sent. |
| `requestTimeoutMs` | 60000 | Give up on one request to the seller after this long. `0` turns it off. The payment stays saved, so a retry re-sends it. |
| `maxPresentations` | 5 | Most times one signed payment may be sent. |
| `expirySkewMs` | 30000 | After the deadline, wait this long before asking the resolver (clocks differ). Calls inside the window throw `UnresolvedPaymentError`. |
| `now` | `Date.now` | Clock. Must return a finite number. |
| `onEvent` | none | Called with `signed`, `presented`, `settled`, `resolved` and `conflict` events. They carry only the intent key, never the payment. A throwing listener is ignored. |

### What a call does

1. A call already cancelled by its `AbortSignal` throws at once and uses nothing.
2. The purchase key is worked out. Overlapping calls for one key share one run and each gets its own copy of the response.
3. The saved record is read and validated. A damaged or edited record throws `InvalidRecordError`; it is never treated as "no payment".
4. See the table in the README for what each state does.
5. The paid request is sent with `redirect: 'manual'`. A same-origin redirect on a `GET` or `HEAD` is followed with the payment re-attached; anything else throws `UnsafeRedirectError`.
6. A 2xx marks the purchase `settled`. If the body then dies halfway, the purchase goes back to `presented`, so a retry re-sends the same payment. When the body completes, the signed payment is removed from the record.

## Errors

Every error with a `record` carries it as a **non-enumerable** property, so logging or serialising the error never prints the signed payment. Read it as `error.record`.

| Error | Meaning | What to do |
|---|---|---|
| `SettledWithoutDeliveryError` | The payment settled on chain; the resource never reached you. `record.settle.transaction` holds the transaction when it could be found. | Ask the seller to deliver or refund, quoting the transaction. Do not pay again. After you have sorted it out, `forget(record.intent)`. |
| `UnresolvedPaymentError` | The payment may or may not have settled and nothing can tell. Nothing new was signed. | If it says the deadline just passed: retry in about `expirySkewMs`. If there is no resolver or it cannot answer: check the chain yourself, then `forget`. |
| `AlreadySettledError` | You used an explicit key that already has a settled payment. | Use a new key for a new purchase. |
| `PurchaseSettledElsewhereError` | Another process finished this purchase while your call was waiting. | The data went to that process. Nothing was charged by this call. |
| `TooManyPresentationsError` | The same signed payment was sent `maxPresentations` times. | Wait for the deadline; the next call checks the chain. |
| `InvalidRecordError` | A saved record is damaged, edited or from a newer version. | Inspect the store; fix or remove the record. |
| `ValidityTooLongError` | The seller asked for a payment valid longer than `maxValidityMs`. | Raise the limit only if you trust the seller. |
| `PaymentMismatchError` | The signed payment does not match the seller's offer or your `limits`. Nothing was saved or sent. | Check the signer and your limits; treat an unexpected mismatch as a security event. |
| `InsecureTransportError` | The paid request would go over plain http. | Use https. |
| `UnsafeRedirectError` | The paid request was redirected where the payment must not go. The payment stays saved. | Call the seller's final URL directly. |
| `StoreConflictError` | The store kept changing underneath this call. | Retry. |

## Stores

`PaymentStore` has `get`, `compareAndSet(intent, expectedVersion, next)` (must answer exactly `{ ok: true }` or `{ ok: false, current }`) and optional `delete`. A store shared by processes must make `compareAndSet` atomic.

- `new MemoryPaymentStore({ maxFinishedRecords = 1000 })`: in process. Keeps open purchases (`presented`, `undelivered`) always; drops the oldest finished ones past the limit.
- `new FilePaymentStore({ directory, lockTimeoutMs = 5000, staleLockMs = 15000 })` from `x402-once/node`: one JSON file per purchase, flushed to disk before it is visible, per-purchase lock. Refuses a directory that is a symlink, owned by someone else or writable by group or others. `await store.prune({ olderThanMs, includeExplicit? })` deletes finished purchases not touched for that long and stale temporary files; it never deletes open purchases or unreadable files, and keeps records for keys you chose (which is what makes "this exact purchase, ever" true) unless `includeExplicit` is set. Not for several machines sharing a drive.

Records carry `schema: 1`. A record with a newer schema is refused, never guessed at.

## Resolvers

`resolver(record)` returns `'settled' | 'unsettled' | 'unknown'` or `{ verdict, transaction? }`. A throw, a timeout or anything else counts as `unknown`.

`evmAuthorizationResolver({ rpcUrls, minProviders = 1, fetch?, lookbackBlocks = 5000, unsettledMarginSeconds = 60, blockTag = 'latest', requestTimeoutMs = 10000 })`. `rpcUrls[network]` is a URL or an array of URLs (https; plain http only for localhost). "Settled" is believed from any one provider; "never settled" needs **every** provider to agree, so one lying or lagging node cannot cause a second payment. `minProviders` refuses to set the resolver up with fewer providers per network; use 2 or more in production. Each provider must be on the chain the seller named (`eth_chainId`). It handles EIP-3009 payments (`authorizationState`) and Permit2 payments (Permit2's `nonceBitmap`; no transaction lookup for Permit2). It reads the token contract's `authorizationState` and the latest block's timestamp from the **same block**. It answers `settled` when the authorization was used (and finds the transaction in the last `lookbackBlocks` blocks when it can), `unsettled` only when the chain's own clock is at least `unsettledMarginSeconds` past `validBefore`, and `unknown` for everything else: an RPC error, a reply that is not exactly one 32-byte word, a network without an RPC URL.

## Testing kit (`x402-once/testing`)

`createSimulatedMerchant({ faults, serveOnReplay, maxTimeoutSeconds, latencyMs, now })` is an in-process seller and facilitator that counts distinct settlements. `createFakeClient(network, { now })` is a signer with no cryptography. `scriptedFaults(...)` and `randomFaults(seed, weights)` choose faults: `drop-before-settle`, `error-before-settle`, `drop-after-settle`, `error-after-settle`, `fresh-402-after-settle`.

## Not covered

Solana and other non-EVM schemes (refused before sending unless `allowUninspected`), x402 v1 payloads, axios, `@x402/fetch` recovery hooks. Spend limits (maximum amount, allowed payees) are your `x402Client`'s job; this package does not add them. The derived purchase key does not include request headers such as `Authorization`: two callers with different credentials but the same URL, method and body share a purchase, so pass an `intentKey` that includes the caller if that matters.
