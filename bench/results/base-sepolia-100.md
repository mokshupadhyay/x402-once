# Benchmark: Base Sepolia (84532), public x402.org facilitator, real USDC

Run 2026-11-27T08:01:32.925Z. 100 purchases per row, 2 retries on a dropped connection or 5xx, fault seed `bench-2`, price 0.001 USDC.

## No faults (sanity check)

| Client | Delivered | Transfers on chain | Items charged twice | Extra transfers | Paid, not delivered | …and told so | Median ms |
|---|---|---|---|---|---|---|---|
| stock @x402/fetch | 92/100 | 92 | 0 | 0 | 0 | 0 | 1024 |
| x402-once | 94/100 | 94 | 0 | 0 | 0 | 0 | 1004 |

## 30% of paid requests hit a fault; seller does not replay

| Client | Delivered | Transfers on chain | Items charged twice | Extra transfers | Paid, not delivered | …and told so | Median ms |
|---|---|---|---|---|---|---|---|
| stock @x402/fetch | 92/100 | 113 | 17 | 19 | 2 | 0 | 1005 |
| x402-once | 77/100 | 96 | 0 | 0 | 19 | 19 | 995 |

## 30% of paid requests hit a fault; seller replays a settled payment

| Client | Delivered | Transfers on chain | Items charged twice | Extra transfers | Paid, not delivered | …and told so | Median ms |
|---|---|---|---|---|---|---|---|
| stock @x402/fetch | 89/100 | 109 | 14 | 16 | 4 | 0 | 991 |
| x402-once | 95/100 | 95 | 0 | 0 | 0 | 0 | 989 |
