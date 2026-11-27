import type { PaymentRecord, SettlementFinding } from './types.js';

interface Eip3009Authorization {
  from?: unknown;
  nonce?: unknown;
  validBefore?: unknown;
}

interface Permit2Authorization {
  from?: unknown;
  nonce?: unknown;
  deadline?: unknown;
}

function permit2Of(payload: Record<string, unknown>): Permit2Authorization | undefined {
  const auth = payload['permit2Authorization'];
  return auth && typeof auth === 'object' ? (auth as Permit2Authorization) : undefined;
}

function authorizationOf(payload: Record<string, unknown>): Eip3009Authorization | undefined {
  const auth = payload['authorization'];
  return auth && typeof auth === 'object' ? (auth as Eip3009Authorization) : undefined;
}

/**
 * When a signed payment stops being valid, in ms since the epoch.
 * EVM `exact` payments carry `authorization.validBefore` (seconds). Anything else falls back to the signing time plus
 * the seller's `maxTimeoutSeconds`.
 */
export function expiryOf(payload: Record<string, unknown>, maxTimeoutSeconds: number, signedAt: number): number {
  const validBefore = Number(authorizationOf(payload)?.validBefore ?? permit2Of(payload)?.deadline);
  if (Number.isFinite(validBefore) && validBefore > 0) return validBefore * 1000;
  return signedAt + maxTimeoutSeconds * 1000;
}

export interface EvmAuthorizationResolverOptions {
  /**
   * JSON-RPC URL per network, keyed by the CAIP-2 id the seller uses, for example `eip155:8453`. Give an array to
   * use several independent providers: "settled" is believed from any one of them, but "never settled" (the answer
   * that can lead to a second payment) needs ALL of them to agree. Use https; plain http is refused except for localhost.
   */
  rpcUrls: Record<string, string | string[]>;
  fetch?: typeof globalThis.fetch;
  /**
   * How many blocks back to look for the transaction that used the authorization, so the error can name it.
   * Best effort: when the RPC refuses the range, the verdict is still returned, just without a transaction. Default 5000.
   */
  lookbackBlocks?: number;
  /**
   * "Never settled" is only reported once the chain's own clock is this many seconds past the deadline, which leaves
   * room for a facilitator's late submission and for a head reorg. Default 60.
   */
  unsettledMarginSeconds?: number;
  /** Which block to read: `latest` (default), or `safe` / `finalized` on chains that have them (slower, harder to reorg). */
  blockTag?: 'latest' | 'safe' | 'finalized';
  /** Give up on one RPC call after this many ms. Default 10000. */
  requestTimeoutMs?: number;
  /**
   * Refuse to be set up with fewer providers than this for any network. A single provider can be wrong or lagging,
   * and "never settled" is the answer that can lead to a second payment. Default 1; use 2 or more in production.
   */
  minProviders?: number;
}

const AUTHORIZATION_STATE = '0xe94a0102'; // authorizationState(address,bytes32), the EIP-3009 view function
const AUTHORIZATION_USED = '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5'; // keccak256("AuthorizationUsed(address,bytes32)")
const MAX_RPC_BYTES = 1024 * 1024;
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const NONCE_BITMAP = '0x4fe02b44'; // nonceBitmap(address,uint256) on Permit2
const wordOf = (value: bigint) => value.toString(16).padStart(64, '0');

const pad32 = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');

function checkRpcUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`x402-once: "${url}" is not a valid RPC URL`);
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
    throw new Error(`x402-once: RPC URL ${parsed.origin} must use https (the answer decides whether a second payment is signed)`);
  }
}

/**
 * Asks the token contract whether an EIP-3009 authorization was used (`authorizationState`).
 * `true` means the payment settled. `false` means it can never settle only once the latest block's timestamp is past
 * `validBefore` plus a margin; before that, or if the chain time cannot be read, the answer is `unknown`. The RPC must
 * be on the chain the seller named (`eth_chainId`). Any doubt returns `unknown`.
 * Read-only: no key, no signature, no transaction. The RPC provider does learn the payer address and the nonce.
 */
export function evmAuthorizationResolver(options: EvmAuthorizationResolverOptions): (record: PaymentRecord) => Promise<SettlementFinding> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const lookback = options.lookbackBlocks ?? 5000;
  const margin = options.unsettledMarginSeconds ?? 60;
  const tag = options.blockTag ?? 'latest';
  const timeoutMs = options.requestTimeoutMs ?? 10_000;
  const urlsFor = new Map<string, string[]>();
  for (const [network, value] of Object.entries(options.rpcUrls)) {
    const list = (Array.isArray(value) ? value : [value]).filter((u) => typeof u === 'string');
    list.forEach(checkRpcUrl);
    if (list.length < (options.minProviders ?? 1)) throw new Error(`x402-once: ${network} has ${list.length} RPC provider(s); minProviders is ${options.minProviders}`);
    urlsFor.set(network, list);
  }

  async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
    const response = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      redirect: 'error',
      ...(typeof AbortSignal.timeout === 'function' ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
    if (!response.ok) throw new Error(`RPC ${method} answered ${response.status}`);
    const text = await response.text();
    if (text.length > MAX_RPC_BYTES) throw new Error('RPC answer too large');
    const body = JSON.parse(text) as { result?: unknown; error?: unknown };
    if (body.error || body.result === undefined) throw new Error(`RPC ${method} failed`);
    return body.result;
  }

  /**
   * The transaction that emitted AuthorizationUsed for this authorization, or undefined when it cannot be found.
   * Public RPCs often refuse log queries over a wide block range (about 200 blocks is common), so a wide window is
   * tried first and a narrow one after it: a settlement is normally only a few minutes old when this runs.
   */
  async function findTransaction(url: string, asset: string, from: string, nonce: string, at: string): Promise<string | undefined> {
    let latest: bigint;
    try {
      latest = at === 'latest' ? BigInt((await rpc(url, 'eth_blockNumber', [])) as string) : BigInt(at);
    } catch {
      return undefined;
    }
    for (const window of [...new Set([lookback, 150])]) {
      try {
        const first = latest > BigInt(window) ? latest - BigInt(window) : 0n;
        const logs = (await rpc(url, 'eth_getLogs', [
          { address: asset, fromBlock: '0x' + first.toString(16), toBlock: at, topics: [AUTHORIZATION_USED, '0x' + pad32(from), '0x' + pad32(nonce)] },
        ])) as Array<{ transactionHash?: unknown }>;
        const hash = logs[0]?.transactionHash;
        if (typeof hash === 'string') return hash;
      } catch {
        /* try the narrower window */
      }
    }
    return undefined;
  }

  /** One provider's answer. */
  async function ask(url: string, record: PaymentRecord): Promise<SettlementFinding> {
    const accepted = record.payload.accepted;
    const eip3009 = authorizationOf(record.payload.payload);
    const permit2 = permit2Of(record.payload.payload);
    const owner = eip3009?.from ?? permit2?.from;
    if ((!eip3009 && !permit2) || typeof owner !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(owner)) return { verdict: 'unknown' };
    const nonce = eip3009?.nonce ?? permit2?.nonce;
    if (eip3009 && (typeof nonce !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(nonce))) return { verdict: 'unknown' };
    if (!eip3009 && (typeof nonce !== 'string' || !/^[0-9]{1,78}$/.test(nonce))) return { verdict: 'unknown' };
    const deadline = Number(eip3009?.validBefore ?? permit2?.deadline);
    try {
      // The RPC must be on the chain the seller named, or its answer is about some other token that shares an address.
      const wanted = /^eip155:([0-9]+)$/.exec(accepted.network)?.[1];
      if (!wanted) return { verdict: 'unknown' };
      const chainId = (await rpc(url, 'eth_chainId', [])) as string;
      if (typeof chainId !== 'string' || BigInt(chainId) !== BigInt(wanted)) return { verdict: 'unknown' };

      // Read the state and the chain's clock at the SAME block, so a settlement mined in between cannot be missed.
      const block = (await rpc(url, 'eth_getBlockByNumber', [tag, false])) as { number?: unknown; timestamp?: unknown } | null;
      const at = typeof block?.number === 'string' && /^0x[0-9a-f]+$/i.test(block.number) ? block.number : tag === 'latest' ? 'latest' : undefined;
      if (!at) return { verdict: 'unknown' };
      const chainTime = typeof block?.timestamp === 'string' ? Number(BigInt(block.timestamp)) : Number.NaN;

      let used: boolean;
      if (eip3009) {
        const result = await rpc(url, 'eth_call', [{ to: accepted.asset, data: AUTHORIZATION_STATE + pad32(owner) + pad32(nonce as string) }, at]);
        // Exactly one 32-byte word. "0x" (no contract at that address, wrong chain, odd RPC) is NOT "never used".
        if (typeof result !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result)) return { verdict: 'unknown' };
        if (/^0x0{63}1$/.test(result)) used = true;
        else if (/^0x0{64}$/.test(result)) used = false;
        else return { verdict: 'unknown' };
      } else {
        // Permit2 keeps used nonces in a bitmap: word = nonce >> 8, bit = nonce & 255.
        const value = BigInt(nonce as string);
        const word = value >> 8n;
        const result = await rpc(url, 'eth_call', [{ to: PERMIT2, data: NONCE_BITMAP + pad32(owner) + wordOf(word) }, at]);
        if (typeof result !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result)) return { verdict: 'unknown' };
        used = ((BigInt(result) >> (value & 255n)) & 1n) === 1n;
      }

      if (used) {
        const transaction = eip3009 ? await findTransaction(url, accepted.asset, owner, nonce as string, at) : undefined;
        return transaction ? { verdict: 'settled', transaction } : { verdict: 'settled' };
      }
      if (!Number.isFinite(deadline) || deadline <= 0) return { verdict: 'unknown' };
      return chainTime >= deadline + margin ? { verdict: 'unsettled' } : { verdict: 'unknown' };
    } catch {
      return { verdict: 'unknown' };
    }
  }

  return async (record: PaymentRecord): Promise<SettlementFinding> => {
    const network = record.payload.accepted.network;
    const urls = Object.hasOwn(options.rpcUrls, network) ? urlsFor.get(network) : undefined;
    if (!urls || urls.length === 0) return { verdict: 'unknown' };
    const answers = await Promise.all(urls.map((url) => ask(url, record)));
    // "Settled" is believed from any one provider: a false "settled" can only block a purchase, never cause a second payment.
    const settled = answers.find((a) => a.verdict === 'settled' && a.transaction) ?? answers.find((a) => a.verdict === 'settled');
    if (settled) return settled;
    // "Never settled" is what can lead to a second payment, so every provider must say it.
    if (answers.every((a) => a.verdict === 'unsettled')) return { verdict: 'unsettled' };
    return { verdict: 'unknown' };
  };
}
