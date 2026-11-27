# Operations guide

## When a purchase goes wrong

**`SettledWithoutDeliveryError`** means you paid and did not get the resource. The money moved once.
1. Take `error.record.settle.transaction` (when present) and `error.record.intent`. If there is no transaction, look up the authorization nonce on the token contract's `AuthorizationUsed` events for your payer address.
2. Contact the seller with the transaction. Sellers that remember payments can serve the resource again; others refund or credit.
3. Once resolved, call `paidFetch.forget(intent)` so the next call starts a fresh purchase.
Do not retry in a loop. A retry cannot get the data from a seller that refuses to serve a payment twice, and the library will not sign a second payment.

**`UnresolvedPaymentError`** means the library cannot tell whether the payment settled. It signs nothing. Retry after the deadline plus `expirySkewMs` (default 30 s). If the cause is "no resolver is configured" or "the resolver could not tell", add `evmAuthorizationResolver` or check the chain yourself, then `forget`.

**`InvalidRecordError`** means a stored record is damaged or edited. Nothing was sent. Open the store, look at the record, fix or delete it. Do not delete a record whose payment may still be valid unless you have confirmed on chain that it never settled.

**`UnsafeRedirectError`** means the seller redirected the paid request somewhere the payment must not follow. Call the final URL directly.

## Reconciliation

Once a day (or after any incident) compare your records with the chain:
- Records in `presented` older than the deadline: ask the resolver; they should become `expired` (never settled) or `undelivered`.
- Records in `undelivered`: each is money you spent without data. Track them until the seller resolves them.
- Transfers from your payer address to sellers that match no `settled` or `undelivered` record: investigate (a second wallet, a double charge by a seller or facilitator, or a lost record).

## Retention and cleanup

- A delivered purchase keeps only its status, times and transaction; the signed payment is removed once the response body has been read to the end.
- `MemoryPaymentStore` keeps the newest 1000 finished purchases (`maxFinishedRecords`) and every open one.
- `FilePaymentStore`: run `await store.prune({ olderThanMs: 7 * 24 * 3600 * 1000 })` on a schedule. It never removes `presented` or `undelivered` records.
- Files are mode 0600 in a 0700 directory. Keep the directory out of git, out of shared volumes and out of backups you do not control.
- On shutdown, `await paidFetch.idle()` so the last bookkeeping write finishes.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Every call throws `UnresolvedPaymentError: ... no resolver is configured` after a failed attempt | Pass `resolver: evmAuthorizationResolver({ rpcUrls: { '<network>': '<rpc url>' } })`. |
| `Timed out waiting for the lock` | Another process holds the purchase's lock, or a dead process left one. Locks older than `staleLockMs` are broken automatically. |
| `... is writable by group or others` / `symbolic link` | Fix the store directory: `chmod 700`, and point at a real directory. |
| `ValidityTooLongError` | The seller asked for a payment valid longer than `maxValidityMs` (1 hour). |
| Retry returns the seller's 402 | The seller does not replay settled payments and you have no resolver. Add one to get `SettledWithoutDeliveryError` with the transaction. |
| Two different callers share a purchase | The derived key ignores headers. Use `intentKey` to include the caller. |
| A POST with a changing field (timestamp, request id) is treated as a new purchase every time | The key includes the body. Choose `intentKey` or send a stable body. |
| Works on Node 20+, fails on Node 18 | Node 18 has no global `crypto`. Use Node 20 or newer. |

## Threat model

| Threat | What happens |
|---|---|
| Someone reads a saved record | They can present the signed payment until `validBefore`, but it can only pay the signed `payTo` the signed amount. Mitigations: file mode, short validity (`maxValidityMs`), signed payload removed after delivery, never log records. |
| Someone edits a record | Validation refuses anything with an unknown status, missing fields, extra headers or a newer schema. A record that is validly shaped but altered (for example a different status) is not detected; protect the store directory. |
| A buggy or hostile signer, hook or dependency | Before saving or sending, the signed payment is checked against the seller's offer (payee, amount, token, network, nonce, payer, validity) and against your `limits`. A mismatch throws `PaymentMismatchError` and nothing leaves the process. Only the payment headers are accepted from the HTTP client (no `Authorization`, no `Cookie`, no line breaks). Not covered: Permit2 and other non-EIP-3009 payloads are not inspected. |
| A malicious seller | Cannot make the library sign more than once per purchase, cannot get the payment redirected, cannot make it read an unbounded 402 body, cannot make a payment valid for years. It can refuse to serve (you get `SettledWithoutDeliveryError`) or answer a different price (the saved payment is re-sent; the amount is fixed by what was signed). |
| A malicious, stale or wrong-chain RPC | The RPC must report the chain id the seller named; a clean 32-byte answer is required; the block clock must be past the deadline plus a margin (default 60 s). A lie of "settled" can only block a purchase. A lie of "unsettled" is the dangerous one: it can lead to a second payment (bounded to one more price per purchase, and only if the seller really settles twice). Configure two or more independent https providers per network: "never settled" then needs all of them to agree. |
| A chain reorganisation | "Never settled" requires the chain clock to be past the deadline plus a margin, which makes a reorg that flips it very unlikely on Base and other L2s with fixed slot times. A "settled" seen at an unsafe head and later reorged away gives a false `SettledWithoutDeliveryError` (a blocked purchase, fixed with `forget`). Use `blockTag: 'safe'` or `'finalized'` for stricter reads. |
| Someone sees the signed payment (logs, proxies, a seller's CDN) | They can submit it to the chain before the seller does. Funds still go only to the signed payee and amount, but the seller's facilitator then finds the nonce used and the buyer is charged without delivery. You would see it as `SettledWithoutDeliveryError`. Use https only (enforced), keep `validBefore` short (the default cap is 1 hour; most sellers use about a minute), and ask sellers not to log or cache the header. |
| `cancelAuthorization` by the payer | The nonce becomes used, so the resolver reports `settled` without a transaction. That blocks a retry; it never causes a payment. |
| Prune and explicit keys | `prune` keeps records of keys you chose, because deleting them would let the same key buy again. Pass `includeExplicit` only when you want that. |
| A facilitator or seller that settles one payment twice | Not detectable client-side. See x402 issue #786. |
| Disk full | The write fails, nothing is sent, no half-written file stays. |
| Clock wrong on the buyer | The resolver uses the chain's clock for "never settled", so a fast local clock cannot cause a second payment. A NaN clock is refused. |
