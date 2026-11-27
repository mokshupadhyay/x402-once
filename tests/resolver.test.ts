import { describe, expect, it } from 'vitest';
import { evmAuthorizationResolver, type PaymentRecord } from '../src/index.js';
import { scriptedFaults } from '../src/testing/index.js';
import { attempt, chainFetch, setup } from './helpers.js';

const NETWORK = 'eip155:84532';
const RPC = 'https://rpc.test';

async function makeRecord() {
  const { paidFetch, store } = setup({ faults: scriptedFaults('drop-before-settle') });
  await attempt(paidFetch);
  const record = [...(store as unknown as { records: Map<string, PaymentRecord> }).records.values()][0]!;
  const auth = record.payload.payload['authorization'] as { from: string; nonce: string; validBefore: string };
  return { record, auth, validBefore: Number(auth.validBefore) };
}
const hex = (n: number) => '0x' + n.toString(16);
const ONE = '0x' + '0'.repeat(63) + '1';

describe('evmAuthorizationResolver', () => {
  it('asks the token contract the right question, at the block it pinned, on the right chain', async () => {
    const { record, auth, validBefore } = await makeRecord();
    const calls: { method: string; params: unknown[]; init?: RequestInit }[] = [];
    const resolve = evmAuthorizationResolver({ rpcUrls: { [NETWORK]: RPC }, fetch: chainFetch({ call: ONE, timestamp: hex(validBefore + 5), number: '0x2710', calls }) });
    expect((await resolve(record)).verdict).toBe('settled');
    const call = calls.find((c) => c.method === 'eth_call')!;
    const [tx, at] = call.params as [{ to: string; data: string }, string];
    expect(tx.to).toBe(record.payload.accepted.asset);
    expect(tx.data).toBe('0xe94a0102' + '0'.repeat(24) + auth.from.slice(2).toLowerCase() + auth.nonce.slice(2).toLowerCase());
    expect(at).toBe('0x2710'); // the block whose clock it read, not "latest" again
    expect(calls.every((c) => (c.init as RequestInit).redirect === 'error')).toBe(true); // an RPC must not redirect us elsewhere
  });

  it('says "never settled" only once the chain is past the deadline plus the margin', async () => {
    const { record, validBefore } = await makeRecord();
    const at = (timestamp: number, extra = {}) => evmAuthorizationResolver({ rpcUrls: { [NETWORK]: RPC }, fetch: chainFetch({ timestamp: hex(timestamp) }), ...extra })(record);
    expect(await at(validBefore - 1)).toEqual({ verdict: 'unknown' });
    expect(await at(validBefore)).toEqual({ verdict: 'unknown' }); // the contract treats == validBefore as expired, but a reorg could still move it
    expect(await at(validBefore + 59)).toEqual({ verdict: 'unknown' });
    expect(await at(validBefore + 60)).toEqual({ verdict: 'unsettled' });
    expect(await at(validBefore, { unsettledMarginSeconds: 0 })).toEqual({ verdict: 'unsettled' });
  });

  it('cannot read the chain clock: unknown', async () => {
    const { record } = await makeRecord();
    expect(await evmAuthorizationResolver({ rpcUrls: { [NETWORK]: RPC }, fetch: chainFetch({ timestamp: undefined }) })(record)).toEqual({ verdict: 'unknown' });
  });

  it('an RPC on the wrong chain is not believed', async () => {
    const { record, validBefore } = await makeRecord();
    const wrong = evmAuthorizationResolver({ rpcUrls: { [NETWORK]: RPC }, fetch: chainFetch({ chainId: '0x2105', timestamp: hex(validBefore + 999) }) });
    expect(await wrong(record)).toEqual({ verdict: 'unknown' }); // 0x2105 is Base mainnet, but the seller named Base Sepolia
  });

  it.each([
    ['an error from the node', { call: undefined, httpStatus: 500 }],
    ['"0x" (no contract at that address)', { call: '0x' }],
    ['a short word', { call: '0x' + '0'.repeat(62) }],
    ['a long word', { call: '0x' + '0'.repeat(66) }],
    ['a value that is neither 0 nor 1', { call: '0x' + '0'.repeat(63) + '2' }],
    ['a body that is not JSON', { bodyPrefix: 'oops' }],
  ])('%s: unknown', async (_name, options) => {
    const { record, validBefore } = await makeRecord();
    const resolve = evmAuthorizationResolver({ rpcUrls: { [NETWORK]: RPC }, fetch: chainFetch({ timestamp: hex(validBefore + 999), ...options }) });
    expect(await resolve(record)).toEqual({ verdict: 'unknown' });
  });

  it('no RPC for the network, or one that exists only on the prototype chain: unknown', async () => {
    const { record } = await makeRecord();
    expect(await evmAuthorizationResolver({ rpcUrls: {} })(record)).toEqual({ verdict: 'unknown' });
    expect(await evmAuthorizationResolver({ rpcUrls: Object.create({ [NETWORK]: RPC }) })(record)).toEqual({ verdict: 'unknown' });
  });

  it('a huge RPC answer is refused', async () => {
    const { record, validBefore } = await makeRecord();
    const resolve = evmAuthorizationResolver({ rpcUrls: { [NETWORK]: RPC }, fetch: chainFetch({ timestamp: hex(validBefore + 999), bodyPrefix: ' '.repeat(2_000_000) }) });
    expect(await resolve(record)).toEqual({ verdict: 'unknown' });
  });

  describe('several providers', () => {
    const rpcUrls = { [NETWORK]: ['https://a.test', 'https://b.test'] };
    const provider = (answers: Record<string, ReturnType<typeof chainFetch>>) =>
      (async (url: RequestInfo | URL, init?: RequestInit) => answers[String(url).replace(/\/$/, '')]!(url, init)) as typeof fetch;

    it('"never settled" needs every provider to agree', async () => {
      const { record, validBefore } = await makeRecord();
      const ts = hex(validBefore + 999);
      const agree = provider({ 'https://a.test': chainFetch({ timestamp: ts }), 'https://b.test': chainFetch({ timestamp: ts }) });
      expect(await evmAuthorizationResolver({ rpcUrls, fetch: agree })(record)).toEqual({ verdict: 'unsettled' });

      const oneUnsure = provider({ 'https://a.test': chainFetch({ timestamp: ts }), 'https://b.test': chainFetch({ timestamp: ts, call: '0x' }) });
      expect(await evmAuthorizationResolver({ rpcUrls, fetch: oneUnsure })(record)).toEqual({ verdict: 'unknown' });

      const oneStale = provider({ 'https://a.test': chainFetch({ timestamp: ts }), 'https://b.test': chainFetch({ timestamp: hex(validBefore - 100) }) });
      expect(await evmAuthorizationResolver({ rpcUrls, fetch: oneStale })(record)).toEqual({ verdict: 'unknown' });
    });

    it('"settled" is believed from any one provider, even if another says never settled', async () => {
      const { record, validBefore } = await makeRecord();
      const ts = hex(validBefore + 999);
      const mixed = provider({ 'https://a.test': chainFetch({ timestamp: ts }), 'https://b.test': chainFetch({ timestamp: ts, call: ONE }) });
      expect((await evmAuthorizationResolver({ rpcUrls, fetch: mixed })(record)).verdict).toBe('settled');
    });
  });

  it('names the transaction when the chain can show it, and still answers when it cannot', async () => {
    const { record, auth, validBefore } = await makeRecord();
    const txHash = '0x' + 'ab'.repeat(32);
    const calls: { method: string; params: unknown[] }[] = [];
    const found = await evmAuthorizationResolver({
      rpcUrls: { [NETWORK]: RPC },
      lookbackBlocks: 100,
      fetch: chainFetch({ call: ONE, timestamp: hex(validBefore + 5), number: '0x2710', logs: [{ transactionHash: txHash }], calls }),
    })(record);
    expect(found).toEqual({ verdict: 'settled', transaction: txHash });
    const query = calls.find((c) => c.method === 'eth_getLogs')!.params[0] as { fromBlock: string; toBlock: string; topics: string[]; address: string };
    expect(query.fromBlock).toBe(hex(10_000 - 100));
    expect(query.toBlock).toBe('0x2710');
    expect(query.address).toBe(record.payload.accepted.asset);
    expect(query.topics[0]).toBe('0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5');
    expect(query.topics[1]).toBe('0x' + '0'.repeat(24) + auth.from.slice(2).toLowerCase());
    expect(query.topics[2]).toBe(auth.nonce.toLowerCase());

    const noLogs = await evmAuthorizationResolver({ rpcUrls: { [NETWORK]: RPC }, fetch: chainFetch({ call: ONE, timestamp: hex(validBefore + 5), logs: 'fail' }) })(record);
    expect(noLogs).toEqual({ verdict: 'settled' });
  });

  it('reads the block tag you ask for', async () => {
    const { record, validBefore } = await makeRecord();
    const calls: { method: string; params: unknown[] }[] = [];
    await evmAuthorizationResolver({ rpcUrls: { [NETWORK]: RPC }, blockTag: 'finalized', fetch: chainFetch({ timestamp: hex(validBefore + 999), calls }) })(record);
    expect(calls.find((c) => c.method === 'eth_getBlockByNumber')!.params[0]).toBe('finalized');
  });

  it('refuses a plain-http or malformed RPC URL when it is set up', () => {
    expect(() => evmAuthorizationResolver({ rpcUrls: { [NETWORK]: 'http://rpc.example.com' } })).toThrow(/https/);
    expect(() => evmAuthorizationResolver({ rpcUrls: { [NETWORK]: 'not a url' } })).toThrow(/not a valid RPC URL/);
    expect(() => evmAuthorizationResolver({ rpcUrls: { [NETWORK]: 'http://127.0.0.1:8545' } })).not.toThrow();
    expect(() => evmAuthorizationResolver({ rpcUrls: { [NETWORK]: ['https://a.test', 'http://b.example.com'] } })).toThrow(/https/);
  });
});
