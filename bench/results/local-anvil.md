# Benchmark: local anvil chain (31337), real x402 facilitator and seller code

Run 2026-11-27T07:27:15.781Z. 40 purchases per row, 2 retries on a dropped connection or 5xx, fault seed `bench-1`, price 0.001 USDC.

## No faults (sanity check)

| Client | Delivered | Transfers on chain | Items charged twice | Extra transfers | Paid, not delivered | …and told so | Median ms |
|---|---|---|---|---|---|---|---|
| stock @x402/fetch | 40/40 | 40 | 0 | 0 | 0 | 0 | 1045 |
| x402-once | 40/40 | 40 | 0 | 0 | 0 | 0 | 1045 |

## 30% of paid requests hit a fault; seller does not replay

| Client | Delivered | Transfers on chain | Items charged twice | Extra transfers | Paid, not delivered | …and told so | Median ms |
|---|---|---|---|---|---|---|---|
| stock @x402/fetch | 38/40 | 51 | 9 | 11 | 2 | 0 | 1047 |
| x402-once | 31/40 | 40 | 0 | 0 | 9 | 9 | 1042 |

## 30% of paid requests hit a fault; seller replays a settled payment

| Client | Delivered | Transfers on chain | Items charged twice | Extra transfers | Paid, not delivered | …and told so | Median ms |
|---|---|---|---|---|---|---|---|
| stock @x402/fetch | 38/40 | 51 | 9 | 11 | 2 | 0 | 1053 |
| x402-once | 40/40 | 40 | 0 | 0 | 0 | 0 | 1048 |
