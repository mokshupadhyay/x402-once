# Changelog

## Unreleased
- New `scope` option (a string, or a function of the request): who is buying. It is mixed into the key derived from the request, so two buyers who send the same request are two purchases and no longer share one saved payment. Keys made without a scope are unchanged, so existing records stay valid. Raised in x402 #4198.
- `bench/differential.mjs` (`npm run build && node bench/differential.mjs`): stock `@x402/fetch` against `x402-once` on the simulated seller, with 1000 identical concurrent calls, 500 distinct purchases, a lost response, and two buyers with and without `scope`. Results in `bench/results/differential.md`.
- Docs: the guarantee is one presentation per purchase, not one signature; what a crash between signing and saving leaves behind; the chain, not the store, decides an outcome.

## 0.1.1 (2026-11-27)
- Documentation only: README gains a "Related work" section (x402 #4094 proposes the same fix in `@x402/fetch`), the facilitator failure range is corrected to 5 to 8 per 100, and results from a further 40-purchase Base Sepolia run are added.
- First release through npm trusted publishing (staged), with provenance.

## 0.1.0 (2026-11-27)
- `createPaidFetch`: save-before-send, reuse of the signed payment, expiry resolution, single flight.
- `evmAuthorizationResolver`: asks the token contract (`authorizationState`) whether an EIP-3009 authorization was used.
- `MemoryPaymentStore`.
- `x402-once/testing`: in-process fault-injecting seller and fake EVM scheme.
- `x402-once/node`: `FilePaymentStore` (durable, fsync + atomic rename, per-purchase lock, fails closed on corrupt files).
- Resolvers may return `{ verdict, transaction? }`; `evmAuthorizationResolver` finds the transaction (`AuthorizationUsed` log).
- A re-sent payment that the seller refuses and the chain shows as used now throws `SettledWithoutDeliveryError` immediately (with a resolver).
- `bench/`: a benchmark that runs the official x402 seller and facilitator code on a local chain or Base Sepolia and counts transfers on chain.
- Fixes from review: no more overwriting another process's newer payment (`PurchaseSettledElsewhereError`), chain-time check in the resolver, keys bound to the request, safer lock breaking, `resolverTimeoutMs`, a throwing `onEvent` or store write no longer loses a delivered response.
- Hardening from independent security and QA review: the signed payment is never sent across a cross-origin redirect (`UnsafeRedirectError`); damaged or edited records stop the call (`InvalidRecordError`) instead of causing a second payment; errors keep the record non-enumerable so logs never print the signed payment; a 402 body is read with a byte cap; the resolver reads state and chain time at one block and treats anything but one 32-byte word as unknown; a seller cannot make a payment valid for more than `maxValidityMs`; the same FormData is the same purchase; a body that dies after a 200 reopens the purchase; delivered purchases drop the signed payment from the store; response sharing no longer buffers streams or blocks `cancel()`; `requestTimeoutMs`, `paidFetch.idle()`, `FilePaymentStore.prune`, memory store retention limit, record `schema`.
- Permit2 payments are inspected (token, amount, payee, and the spender is pinned to the official x402 proxy) and resolved through Permit2's nonce bitmap; payment types that cannot be inspected are refused before sending unless `allowUninspected`; `minProviders` for the resolver.
