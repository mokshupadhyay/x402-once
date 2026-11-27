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
   - `presented`, before the deadline: send the saved payment again (at most `maxPresentations` times). If the seller refuses a re-sent payment and a resolver is configured, ask it: `settled` -> `undelivered` and throw (the seller took the money and will not serve it twice); anything else -> hand the refusal back unchanged.
   - `presented`, past the deadline: inside the `expirySkewMs` window after the deadline throw `UnresolvedPaymentError` (clocks differ; try again shortly); after it, ask the resolver (a verdict, or `{verdict, transaction}`). `settled` -> `undelivered`. `unsettled` -> `expired`, then sign a new payment. `unknown` or no resolver -> `UnresolvedPaymentError`.
4. No usable record: ask for the price (the 402), sign, then **compare-and-set** the record before sending. If another process saved first, drop the unsent payment and follow its record.

## Why the key is derived this way
Two identical calls are either one purchase retried or two purchases, and nothing in the request says which (x402 #4198). A derived key therefore guards only an **unresolved** attempt. A deliberate second purchase after a delivered one is never blocked. When the caller needs "this exact purchase, ever", they choose the key.

## What is guaranteed, exactly
- **One presentation per purchase, not one signature.** When two processes race on a new purchase, both can sign. The compare-and-set saves one record before anything is sent; the loser drops its payment without sending it. An EIP-3009 authorization only settles when someone presents it, and its nonce is used once, so a signature nobody sends costs nothing.
- **The window that is left: a crash between signing and saving.** Then a signed authorization exists that no record names. This client never sent it, so the money cannot move through this client. It matters only if that signature leaked (a log line, a debugger, a crash dump), or if the signer sends it somewhere itself. Two ways to close it fully, neither possible from a wrapper alone: derive the nonce from the purchase key (so a second, different signature cannot exist), or check the chain for the signer's authorization before signing again. The wrapper cannot choose the nonce, because the scheme does; keep signed payloads out of logs.
- **The store coordinates; the chain decides the outcome.** If the winner crashes after sending, the store holds a purchase with no outcome. Only the chain settles it (`authorizationState` on the signed nonce, which the resolver reads). A settlement that failed leaves the authorization unused (`false`), so the nonce is still the buyer's to use; a response lost after settlement reads `true`, because the money moved. A count of failed purchases mixes the two unless it checks the chain: the first is a facilitator that never landed a transaction, the second is a seller who was paid and did not deliver.
- **A request is not a buyer.** The derived key identifies terms (method, URL, body), not who is paying. Inside one trust domain that is the right trade. For more than one buyer set `scope`, or choose the key yourself.

## Why not a retry queue
The idempotency guarantee here is narrower than a general retry queue: one signed payment per purchase, reused. That needs the store, a state machine and a resolver, not a scheduler. Keeping it separate means one install.

## What the property tests found
The first design set a payment to `settled` when the resolver said it had settled but the resource was never received. Under a derived key, `settled` means "done, the next call is a new purchase", so the next retry paid again. Property testing found it in under 20 random programs. The `undelivered` state fixes it.

## Found by review, fixed
- **A slow process could overwrite a newer payment.** Updates used to re-apply their change on top of whatever record was current. Now an update succeeds only from the exact version it read; on a conflict the call looks again, and if another process already completed the purchase it throws `PurchaseSettledElsewhereError` instead of buying again.
- **"Never settled" trusted the buyer's clock.** The resolver now compares the chain's latest block time with `validBefore`.
- **A chosen key was not tied to the request.** It is now combined with the request's hash.
- **Lock breaking in the file store.** A stale lock is moved aside atomically and a writer re-checks that the lock is still its own right before the new record becomes visible. A residual window remains: a process that stalls between that check and the rename for longer than `staleLockMs` could still lose an update. Use a database store if that matters to you.
