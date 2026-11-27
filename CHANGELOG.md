# Changelog

## 0.0.0 (unreleased)
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
