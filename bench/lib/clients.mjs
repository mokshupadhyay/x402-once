import { x402Client } from '@x402/core/client';
import { toClientEvmSigner } from '@x402/evm';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { createPublicClient, http } from 'viem';
import { createPaidFetch, evmAuthorizationResolver, MemoryPaymentStore } from '../../dist/index.js';

export function buyerClient({ account, chain, rpcUrl, network, spendControls }) {
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const signer = toClientEvmSigner(account, publicClient);
  return x402Client.fromConfig({
    schemes: [{ network, client: new ExactEvmScheme(signer) }],
    ...(spendControls === false ? { spendControls: false } : {}),
  });
}

/** What every agent framework does: the official wrapper, nothing else. */
export function stockFetch(options) {
  return { name: 'stock @x402/fetch', fetch: wrapFetchWithPayment(globalThis.fetch, buyerClient(options)) };
}

/** The same buyer wallet, wrapped by x402-once with the on-chain resolver. */
export function onceFetch(options, rpcUrls) {
  const store = new MemoryPaymentStore();
  const paid = createPaidFetch({
    client: buyerClient(options),
    store,
    resolver: evmAuthorizationResolver({ rpcUrls }),
  });
  return { name: 'x402-once', fetch: paid };
}
