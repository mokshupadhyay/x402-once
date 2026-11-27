# Benchmark: Base Sepolia (84532), public x402.org facilitator, real USDC

Run 2026-11-27T08:12:25.560Z. 40 purchases per row, 2 retries on a dropped connection or 5xx, fault seed `bench-3`, price 0.001 USDC.

## No faults (sanity check)

| Client | Delivered | Transfers on chain | Items charged twice | Extra transfers | Paid, not delivered | …and told so | Median ms |
|---|---|---|---|---|---|---|---|
| stock @x402/fetch | 37/40 | 37 | 0 | 0 | 0 | 0 | 1004 |
| x402-once | 38/40 | 38 | 0 | 0 | 0 | 0 | 987 |

## 30% of paid requests hit a fault; seller does not replay

| Client | Delivered | Transfers on chain | Items charged twice | Extra transfers | Paid, not delivered | …and told so | Median ms |
|---|---|---|---|---|---|---|---|
| stock @x402/fetch | 36/40 | 48 | 7 | 11 | 1 | 0 | 1001 |
| x402-once | 30/40 | 38 | 0 | 0 | 8 | 8 | 1004 |

## 30% of paid requests hit a fault; seller replays a settled payment

| Client | Delivered | Transfers on chain | Items charged twice | Extra transfers | Paid, not delivered | …and told so | Median ms |
|---|---|---|---|---|---|---|---|
| stock @x402/fetch | 33/40 | 45 | 7 | 11 | 1 | 0 | 1002 |
| x402-once | 39/40 | 39 | 0 | 0 | 0 | 0 | 971 |
