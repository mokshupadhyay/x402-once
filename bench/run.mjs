// Pay for N items through a seller that sometimes loses the response after the payment settled, once with the stock
// x402 client and once with x402-once, and count what really moved on the chain.
//
//   node bench/run.mjs --network local                       (needs anvil; nothing else)
//   node bench/run.mjs --network base-sepolia                (needs a funded bench/.wallet.json; see bench/README.md)
import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, parseAbiItem, formatUnits } from 'viem';
import { startAnvil, deployToken, fundWithGas, newAccount, chainFor, LOCAL_CHAIN_ID } from './lib/chain.mjs';
import { startFacilitator } from './lib/facilitator.mjs';
import { startSeller } from './lib/seller.mjs';
import { stockFetch, onceFetch } from './lib/clients.mjs';
import { privateKeyToAccount } from 'viem/accounts';

const { values } = parseArgs({
  options: {
    network: { type: 'string', default: 'local' },
    purchases: { type: 'string', default: '40' },
    'fault-rate': { type: 'string', default: '0.3' },
    retries: { type: 'string', default: '2' },
    seed: { type: 'string', default: 'bench-1' },
    out: { type: 'string', default: 'latest' },
  },
});
const N = Number(values.purchases);
const FAULT_RATE = Number(values['fault-rate']);
const RETRIES = Number(values.retries);
const SEED = values.seed;
const AMOUNT = '1000'; // 0.001 USDC
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

/** The usual agent retry: try again on a dropped connection or a 5xx. Never on a 402. */
async function purchase(fetchImpl, url) {
  const started = performance.now();
  let last;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const response = await fetchImpl(url);
      if (response.status >= 500 && attempt < RETRIES) {
        last = { status: response.status };
        continue;
      }
      const body = response.ok ? await response.json().catch(() => undefined) : undefined;
      return { delivered: response.ok && body?.delivered === true, status: response.status, attempts: attempt + 1, ms: performance.now() - started };
    } catch (error) {
      const name = error?.name ?? 'Error';
      // Only a dropped connection counts as a retryable network failure; any other TypeError is a bug and must surface.
      const dropped = name === 'TypeError' && /fetch failed|terminated|other side closed|ECONNRESET|socket/i.test(`${error?.message} ${error?.cause?.message ?? ''} ${error?.cause?.code ?? ''}`);
      if (!dropped) {
        return { delivered: false, error: name, attempts: attempt + 1, ms: performance.now() - started };
      }
      last = { error: name };
    }
  }
  return { delivered: false, error: last?.error ?? `HTTP ${last?.status}`, attempts: RETRIES + 1, ms: performance.now() - started };
}

async function setup() {
  if (values.network === 'local') {
    const anvil = await startAnvil();
    const token = await deployToken(anvil);
    const buyer = newAccount();
    const facilitatorAccount = newAccount();
    const payTo = newAccount().address;
    await fundWithGas(anvil.rpcUrl, facilitatorAccount.address);
    const mint = await token.wallet.writeContract({ address: token.address, abi: token.abi, functionName: 'mint', args: [buyer.address, 1_000_000_000n] });
    await token.publicClient.waitForTransactionReceipt({ hash: mint });
    const network = `eip155:${LOCAL_CHAIN_ID}`;
    const facilitator = await startFacilitator({ account: facilitatorAccount, chain: anvil.chain, rpcUrl: anvil.rpcUrl, network });
    return { label: 'local anvil chain (31337), real x402 facilitator and seller code', network, chain: anvil.chain, rpcUrl: anvil.rpcUrl, asset: token.address, buyer, payTo, facilitatorUrl: facilitator.url, spendControls: false, cleanup: async () => { await facilitator.stop(); anvil.stop(); } };
  }
  if (values.network === 'base-sepolia') {
    const walletPath = here('./.wallet.json');
    if (!existsSync(walletPath)) throw new Error('No bench/.wallet.json. Run: node bench/wallet.mjs');
    const wallet = JSON.parse(readFileSync(walletPath, 'utf8'));
    const rpcUrl = process.env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org';
    const chain = chainFor(84532, rpcUrl);
    return { label: 'Base Sepolia (84532), public x402.org facilitator, real USDC', network: 'eip155:84532', chain, rpcUrl, asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', buyer: privateKeyToAccount(wallet.buyer.privateKey), payTo: wallet.payTo.address, facilitatorUrl: process.env.X402_FACILITATOR_URL ?? 'https://x402.org/facilitator', spendControls: undefined, cleanup: async () => {} };
  }
  throw new Error(`unknown --network ${values.network}`);
}

const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);

async function main() {
  const env = await setup();
  const publicClient = createPublicClient({ chain: env.chain, transport: http(env.rpcUrl) });
  const balanceAbi = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }];
  const balance = (address) => publicClient.readContract({ address: env.asset, abi: balanceAbi, functionName: 'balanceOf', args: [address] });

  const buyerBalance = await balance(env.buyer.address);
  console.log(`Environment: ${env.label}`);
  console.log(`Buyer ${env.buyer.address} holds ${formatUnits(buyerBalance, 6)} USDC; ${N} purchases of ${formatUnits(BigInt(AMOUNT), 6)} USDC each`);
  // Six rows, and the stock client can pay up to (retries + 1) times for one item.
  const worstCase = BigInt(AMOUNT) * BigInt(N) * BigInt(RETRIES + 1) * 6n;
  if (buyerBalance < worstCase) {
    throw new Error(`The buyer ${env.buyer.address} needs at least ${formatUnits(worstCase, 6)} USDC on ${env.network} and has ${formatUnits(buyerBalance, 6)}.${values.network === 'base-sepolia' ? ' Get test USDC at https://faucet.circle.com (choose Base Sepolia, USDC) and run again.' : ''}`);
  }

  const scenarios = [
    { id: 'no-faults', title: 'No faults (sanity check)', rate: 0, replay: false },
    { id: 'faults-plain-seller', title: `${Math.round(FAULT_RATE * 100)}% of paid requests hit a fault; seller does not replay`, rate: FAULT_RATE, replay: false },
    { id: 'faults-replaying-seller', title: `${Math.round(FAULT_RATE * 100)}% of paid requests hit a fault; seller replays a settled payment`, rate: FAULT_RATE, replay: true },
  ];

  const results = [];
  for (const scenario of scenarios) {
    for (const make of [stockFetch, (o) => onceFetch(o, { [env.network]: env.rpcUrl })]) {
      const seller = await startSeller({ facilitatorUrl: env.facilitatorUrl, network: env.network, payTo: env.payTo, asset: env.asset, amount: AMOUNT, faults: { rate: scenario.rate, seed: SEED }, replay: scenario.replay });
      const client = make({ account: env.buyer, chain: env.chain, rpcUrl: env.rpcUrl, network: env.network, spendControls: env.spendControls });
      const startBlock = await publicClient.getBlockNumber({ cacheTime: 0 });
      const startBalance = await balance(env.payTo);
      const outcomes = [];
      for (let i = 0; i < N; i++) outcomes.push(await purchase(client.fetch, `${seller.base}/item/${i}`));
      if (process.env.DEBUG_BENCH) console.log(JSON.stringify(outcomes.slice(0, 6)), JSON.stringify({ ...seller.stats, log: seller.stats.log.length }));
      // Public RPCs cap eth_getLogs at about 200 blocks, so read the transfers in windows.
      const endBlock = await publicClient.getBlockNumber({ cacheTime: 0 });
      const allLogs = [];
      for (let from = startBlock; from <= endBlock; from += 150n) {
        const to = from + 149n < endBlock ? from + 149n : endBlock;
        allLogs.push(...(await publicClient.getLogs({ address: env.asset, event: transferEvent, args: { to: env.payTo }, fromBlock: from, toBlock: to })));
      }
      const logs = allLogs.filter((log) => log.blockNumber > startBlock);
      const endBalance = await balance(env.payTo);

      const perItem = new Map();
      for (const entry of seller.stats.log) perItem.set(entry.url, (perItem.get(entry.url) ?? 0) + 1);
      const itemOf = (i) => `/item/${i}`;
      const delivered = outcomes.filter((o) => o.delivered).length;
      const paidItems = [...perItem.keys()].length;
      const doubleCharged = [...perItem.values()].filter((c) => c > 1).length;
      const paidNotDelivered = outcomes.filter((o, i) => !o.delivered && perItem.has(itemOf(i))).length;
      const errors = {};
      for (const o of outcomes) if (o.error) errors[o.error] = (errors[o.error] ?? 0) + 1;
      const toldItWasPaid = errors.SettledWithoutDeliveryError ?? 0;
      const transfers = logs.length;
      const moved = endBalance - startBalance;
      const row = {
        scenario: scenario.id,
        title: scenario.title,
        client: client.name,
        purchases: N,
        delivered,
        itemsPaidFor: paidItems,
        transfersOnChain: transfers,
        movedUsdc: formatUnits(moved, 6),
        itemsChargedTwiceOrMore: doubleCharged,
        extraTransfers: transfers - paidItems,
        paidButNotDelivered: paidNotDelivered,
        toldItWasPaid,
        sellerReplays: seller.stats.replays,
        rejections: seller.stats.rejections.slice(0, 20),
        faultsInjected: seller.stats.faultsInjected,
        errors,
        medianMs: Math.round(median(outcomes.map((o) => o.ms))),
        checks: { chainMatchesBalance: moved === BigInt(AMOUNT) * BigInt(transfers), sellerLogMatchesChain: seller.stats.settledBySeller === transfers },
      };
      if (!row.checks.chainMatchesBalance || !row.checks.sellerLogMatchesChain) {
        throw new Error(`Measurement check failed for ${scenario.id} / ${client.name}: ${JSON.stringify(row.checks)}`);
      }
      results.push(row);
      console.log(`  ${scenario.id.padEnd(24)} ${client.name.padEnd(18)} delivered ${String(delivered).padStart(3)}/${N}  transfers ${String(transfers).padStart(3)}  items paid ${String(paidItems).padStart(3)}  charged twice ${String(doubleCharged).padStart(2)}  paid-not-delivered ${String(paidNotDelivered).padStart(2)} (told so: ${toldItWasPaid})  ${JSON.stringify(errors)}`);
      await seller.stop();
    }
  }
  await env.cleanup();

  mkdirSync(here('./results'), { recursive: true });
  const report = { when: new Date().toISOString(), environment: env.label, network: env.network, purchases: N, faultRate: FAULT_RATE, retries: RETRIES, seed: SEED, amountAtomic: AMOUNT, results };
  writeFileSync(here(`./results/${values.out}.json`), JSON.stringify(report, null, 2));
  writeFileSync(here(`./results/${values.out}.md`), toMarkdown(report));
  console.log(`\nWrote bench/results/${values.out}.json and .md`);
}

function toMarkdown(report) {
  const lines = [`# Benchmark: ${report.environment}`, '', `Run ${report.when}. ${report.purchases} purchases per row, ${report.retries} retries on a dropped connection or 5xx, fault seed \`${report.seed}\`, price ${formatUnits(BigInt(report.amountAtomic), 6)} USDC.`, ''];
  for (const id of [...new Set(report.results.map((r) => r.scenario))]) {
    const rows = report.results.filter((r) => r.scenario === id);
    lines.push(`## ${rows[0].title}`, '', '| Client | Delivered | Transfers on chain | Items charged twice | Extra transfers | Paid, not delivered | …and told so | Median ms |', '|---|---|---|---|---|---|---|---|');
    for (const r of rows) lines.push(`| ${r.client} | ${r.delivered}/${r.purchases} | ${r.transfersOnChain} | ${r.itemsChargedTwiceOrMore} | ${r.extraTransfers} | ${r.paidButNotDelivered} | ${r.toldItWasPaid} | ${r.medianMs} |`);
    lines.push('');
  }
  return lines.join('\n');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
