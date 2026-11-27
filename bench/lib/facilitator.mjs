// The real x402 facilitator code (verify + settle through the official EVM scheme), served over HTTP the way a hosted one is.
import { createServer } from 'node:http';
import { createPublicClient, createWalletClient, http } from 'viem';
import { x402Facilitator } from '@x402/core/facilitator';
import { toFacilitatorEvmSigner } from '@x402/evm';
import { ExactEvmScheme } from '@x402/evm/exact/facilitator';

export async function startFacilitator({ account, chain, rpcUrl, network, port = 0, pollingInterval = 250 }) {
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval });
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const signer = toFacilitatorEvmSigner({
    address: account.address,
    readContract: (args) => publicClient.readContract(args),
    verifyTypedData: (args) => publicClient.verifyTypedData(args),
    writeContract: (args) => wallet.writeContract(args),
    sendTransaction: (args) => wallet.sendTransaction(args),
    waitForTransactionReceipt: (args) => publicClient.waitForTransactionReceipt(args),
    getCode: (args) => publicClient.getCode(args),
  });
  const facilitator = new x402Facilitator().register(network, new ExactEvmScheme(signer));
  const counters = { verify: 0, settle: 0, settleOk: 0 };

  const server = createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && req.url === '/supported') return send(200, facilitator.getSupported());
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (req.url === '/verify') {
        counters.verify++;
        return send(200, await facilitator.verify(body.paymentPayload, body.paymentRequirements));
      }
      if (req.url === '/settle') {
        counters.settle++;
        const result = await facilitator.settle(body.paymentPayload, body.paymentRequirements);
        if (result.success) counters.settleOk++;
        return send(200, result);
      }
      send(404, { error: 'not found' });
    } catch (error) {
      send(500, { error: String(error?.message ?? error) });
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, counters, stop: () => new Promise((resolve) => server.close(resolve)) };
}
