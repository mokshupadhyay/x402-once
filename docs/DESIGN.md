# Design

## The rule everything rests on
The signed payment is written to the store **before** it is sent. If the process dies, the response is lost, or the app retries, the payment is on record and is sent again unchanged. A new payment is signed only when the old one provably cannot settle.

## State of one purchase
`presented` (signed, saved, sent at least once) -> `settled` (2xx, delivered) | `undelivered` (settled on chain, never delivered) | `expired` (past its deadline and never used) | `abandoned` (caller gave up).

## Rules on a call
1. Work out the purchase key: the caller's key (`intentKey`, then an `Idempotency-Key` header), else a hash of method, URL and body.
2. Calls for one key that overlap in time share one run (single flight). Each caller gets its own copy of the response.
3. Look up the record.
   - `settled` with a derived key: a new purchase. With a chosen key: `AlreadySettledError`.
   - `undelivered`: `SettledWithoutDeliveryError`, every time, until `forget`.
   - `presented`, before the deadline: send the saved payment again (at most `maxPresentations` times).
   - `presented`, past the deadline: wait out `expirySkewMs`, then ask the resolver. `settled` -> `undelivered`. `unsettled` -> `expired`, then sign a new payment. `unknown` or no resolver -> `UnresolvedPaymentError`.
4. No usable record: ask for the price (the 402), sign, then **compare-and-set** the record before sending. If another process saved first, drop the unsent payment and follow its record.

## Why the key is derived this way
Two identical calls are either one purchase retried or two purchases, and nothing in the request says which (x402 #4198). A derived key therefore guards only an **unresolved** attempt. A deliberate second purchase after a delivered one is never blocked. When the caller needs "this exact purchase, ever", they choose the key.

## Why not a retry queue
The idempotency guarantee here is narrower than a general retry queue: one signed payment per purchase, reused. That needs the store, a state machine and a resolver, not a scheduler. Keeping it separate means one install.

## What the property tests found
The first design set a payment to `settled` when the resolver said it had settled but the resource was never received. Under a derived key, `settled` means "done, the next call is a new purchase", so the next retry paid again. Property testing found it in under 20 random programs. The `undelivered` state fixes it.
