# Benchmark: local anvil chain (31337), real x402 facilitator and seller code

Run 2026-11-27T06:26:28.294Z. 40 purchases per row, 2 retries on a dropped connection or 5xx, fault seed `bench-1`, price 0.001 USDC.

## No faults (sanity check)

| Client | Delivered | Transfers on chain | Items charged twice | Extra transfers | Paid, not delivered | …and told so | Median ms |
|---|---|---|---|---|---|---|---|
| stock @x402/fetch | 40/40 | 40 | 0 | 0 | 0 | 0 | 1019 |
| x402-once | 40/40 | 40 | 0 | 0 | 0 | 0 | 1040 |

## 30% of paid requests hit a fault; seller does not replay

| Client | Delivered | Transfers on chain | Items charged twice | Extra transfers | Paid, not delivered | …and told so | Median ms |
|---|---|---|---|---|---|---|---|
| stock @x402/fetch | 38/40 | 51 | 9 | 11 | 2 | 0 | 1039 |
| x402-once | 31/40 | 40 | 0 | 0 | 9 | 9 | 1040 |

## 30% of paid requests hit a fault; seller replays a settled payment

| Client | Delivered | Transfers on chain | Items charged twice | Extra transfers | Paid, not delivered | …and told so | Median ms |
|---|---|---|---|---|---|---|---|
| stock @x402/fetch | 38/40 | 51 | 9 | 11 | 2 | 0 | 1040 |
| x402-once | 40/40 | 40 | 0 | 0 | 0 | 0 | 1040 |
