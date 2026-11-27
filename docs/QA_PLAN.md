# QA plan and launch gates

Written as a QA lead would before a first public release. Status is what has actually been run; "open" means not done.

## 1. Functional (does it do the job)

| Scenario | How it is checked | Status |
|---|---|---|
| Normal purchase pays once and delivers | unit | done |
| Free resource passes through untouched | unit | done |
| Lost response, 5xx, timeout, drop before and after settlement: retry re-sends the same signed payment | unit, property, real-chain benchmark | done |
| Process restart reuses the saved payment | unit with `FilePaymentStore` | done |
| Deadline passed: chain says used / never used / cannot tell / no resolver | unit | done |
| Settled but not delivered stays blocked on every retry, never buys again | unit, property | done |
| Explicit key: bound to the request, cannot be paid twice | unit | done |
| Overlapping calls share one payment; 500 parallel same-URL calls make 1 payment | unit, load check | done |
| Two processes on one store: only one payment saved and sent | unit, differential test | done |
| Seller refuses a re-sent payment; chain says used: reported with the transaction | unit, Base Sepolia | done |
| POST bodies, FormData, streamed bodies, HEAD/OPTIONS retries | unit, adversarial QA | done |
| Abort and timeout between save and send | unit, adversarial QA | done |
| Body dies after a 200: purchase reopens, retry re-sends the same payment | unit | done |
| Caller cancels a large download without hanging | unit | done |

## 2. UAT (what a real user does)

| Scenario | Status |
|---|---|
| Follow the README's offline example from a clean project and get `200 1` | done (run on Node 20, 24, Bun, Deno) |
| Follow the real-money example on Base Sepolia with a funded wallet | done via `bench/` (not as a copy-paste of the README snippet); **open**: a person other than the author does it once and reports confusion |
| Install the packed tarball in an empty project (ESM, CJS, types) | done |
| Use it from an AI agent loop that retries on failure | **open**: one worked example against a real agent framework |

## 3. Non-functional

| Area | Result | Status |
|---|---|---|
| Overhead per call (in-process seller) | about 40 µs over the stock wrapper | done |
| File store cost | about 18 ms per purchase (flush to disk); negligible next to a 1 s settlement | done |
| Parallel load | 500 distinct purchases in parallel: 500 settlements; 500 identical: 1 | done |
| Memory | in-memory store capped (1000 finished records); streaming bodies are not buffered | done |
| Soak: hours of purchases with random faults, memory flat | **open** |
| Seller outage and slow seller | timeout default 60 s, tested | done |
| Large responses | 300 MB class bodies stream; cancel releases them | done |
| Node 18 | unsupported by design (`engines` is 20 or newer) | done |

## 4. Reliability and failure injection

- Property test: random fault sequences, clock jumps, retries; no purchase paid twice (30,000 runs pass; CI repeats it).
- Differential test: 400 random runs, 2 to 3 wrappers sharing one store and seller; no violation.
- Mutation check: 60 hand-picked deliberate breaks of the source; the tests must fail for each (see MUTATION_EVIDENCE.md).
- Real network: Base Sepolia benchmark, 2 runs of 20 purchases, public facilitator. **Open**: 100+ purchases over several seeds, and a seller the author does not control.

## 5. Security

Independent review done (see the "Found by review, fixed" list in DESIGN.md): redirects, tampered records, error leakage, oversized bodies, resolver edge cases, validity caps, file store hygiene. `npm audit`: 0 vulnerabilities, no install scripts, tarball contains only `dist`, README, LICENSE, CHANGELOG, package.json. **Open**: a second reviewer who is not an AI, once the code is public.

## 6. Compatibility

| Target | Status |
|---|---|
| Node 20, 22 (CI), 24, ESM and CJS | 20 and 24 run locally, 22 in CI |
| Bun, Deno (ESM) | done |
| `@x402/core` 2.32.0 | done |
| `@x402/core` newer minors | CI job installs the latest and re-runs typecheck and tests |
| Edge runtimes (no `node:` in the main entry) | main entry checked for `node:` imports: none |
| Solana, x402 v1, axios | not supported (fails closed). Stated in the README |

## 7. Release gates (must all be true before publishing)

1. All tests, type check and build pass in CI on Node 20, 22 and 24.
2. Property check at 30,000 runs passes.
3. Mutation check: no MISSED rows.
4. `npm publish --dry-run` shows only the intended files.
5. Benchmark numbers in the README match `bench/results/*.json`.
6. `repository`, `homepage`, `bugs` and `author` set in package.json, and the GitHub repository exists. (open: needs the repository URL)
7. Version bumped from 0.0.0 and the CHANGELOG entry dated. (open)
8. Employment-terms check done. (done: confirmed by the author)
9. README says plainly when not to use it, and the plain-seller trade-off.
10. No secrets in the tree or history (`bench/.wallet.json` is git-ignored; the tarball is clean).

## 8. Before the article

- Numbers come from `bench/results/*.json`, quoted with the run count and the caveats (small sample, one network, faults injected by a proxy, facilitator failures in run 2).
- Show both sides of the trade-off: money saved versus items not delivered with a plain seller.
- Say what it does not do: other schemes, a facilitator or seller that settles twice, several machines on one store.
- Link the x402 issues (#3438, #4198, #4367, #786) and do not post anywhere until approved.
- Re-run the benchmark on the final code and attach the result files.
