// A seller built from the official x402 server code (x402ResourceServer + x402HTTPResourceServer), the same pieces the
// Express/Hono/Next middlewares use, with one addition: it can lose the response after a payment settled.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import { x402HTTPResourceServer } from '@x402/core/http';
import { decodePaymentSignatureHeader } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/server';

/** Same number for the same inputs on every run, so both clients face the same bad luck. */
function unit(...parts) {
  const digest = createHash('sha256').update(parts.join('|')).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

/**
 * faults: { rate, seed } — each paid request to a URL rolls a fault by (seed, url, how many paid requests that URL has seen).
 *   50% of faults drop the connection after the payment settled (the case that matters),
 *   25% answer 503 after it settled, 25% drop the connection before settling (harmless, nothing moved).
 * replay: when true, the seller remembers each payment nonce and serves the same answer again instead of charging.
 */
export async function startSeller({ facilitatorUrl, network, payTo, asset, amount, maxTimeoutSeconds = 60, faults = { rate: 0, seed: 'x' }, replay = false, port = 0 }) {
  const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitatorUrl })).register('eip155:*', new ExactEvmScheme());
  await resourceServer.initialize();
  const routes = {
    'GET /item/*': {
      accepts: { scheme: 'exact', network, payTo, price: { amount, asset, extra: { name: 'USDC', version: '2' } }, maxTimeoutSeconds },
      description: 'One paid item',
      mimeType: 'application/json',
    },
  };
  const httpServer = new x402HTTPResourceServer(resourceServer, routes);
  await httpServer.initialize();

  const seen = new Map(); // url -> number of paid requests so far
  const remembered = new Map(); // nonce -> { status, headers, body }
  const stats = { unpaid: 0, paid: 0, settledBySeller: 0, faultsInjected: { dropAfterSettle: 0, error503AfterSettle: 0, dropBeforeSettle: 0 }, replays: 0, rejected: 0, log: [] };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://seller.local');
    const header = req.headers['payment-signature'];
    const adapter = {
      getHeader: (name) => req.headers[name.toLowerCase()],
      getMethod: () => req.method,
      getPath: () => url.pathname,
      getUrl: () => url.toString(),
      getAcceptHeader: () => req.headers['accept'] ?? 'application/json',
      getUserAgent: () => req.headers['user-agent'] ?? '',
    };
    const respond = (status, headers, body) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body ?? {}));
    };

    if (!header) stats.unpaid++;
    else stats.paid++;

    let nonce;
    if (header) {
      try {
        nonce = decodePaymentSignatureHeader(header).payload?.authorization?.nonce;
      } catch {
        nonce = undefined;
      }
      if (replay && nonce && remembered.has(nonce)) {
        stats.replays++;
        const earlier = remembered.get(nonce);
        return respond(earlier.status, earlier.headers, earlier.body);
      }
    }

    let fault = 'none';
    if (header) {
      const count = (seen.get(url.pathname) ?? 0) + 1;
      seen.set(url.pathname, count);
      if (unit('hit', faults.seed, url.pathname, count) < faults.rate) {
        const kind = unit('kind', faults.seed, url.pathname, count);
        fault = kind < 0.5 ? 'dropAfterSettle' : kind < 0.75 ? 'error503AfterSettle' : 'dropBeforeSettle';
      }
    }

    try {
      const result = await httpServer.processHTTPRequest({ adapter, path: url.pathname, method: req.method, paymentHeader: header });
      if (result.type === 'payment-error') {
        if (header) stats.rejected++;
        return respond(result.response.status, result.response.headers, result.response.body);
      }
      if (result.type === 'no-payment-required') return respond(200, {}, { free: true });

      if (fault === 'dropBeforeSettle') {
        stats.faultsInjected.dropBeforeSettle++;
        return req.socket.destroy();
      }
      const body = { item: url.pathname, delivered: true };
      const settlement = await httpServer.processSettlement(result.paymentPayload, result.paymentRequirements, result.declaredExtensions, {
        request: { adapter, path: url.pathname, method: req.method, paymentHeader: header },
        responseBody: Buffer.from(JSON.stringify(body)),
      });
      if (!settlement.success) {
        stats.rejected++;
        return respond(settlement.response.status, settlement.response.headers, settlement.response.body);
      }
      stats.settledBySeller++;
      stats.log.push({ url: url.pathname, nonce, transaction: settlement.transaction });
      if (replay && nonce) remembered.set(nonce, { status: 200, headers: settlement.headers, body });

      if (fault === 'dropAfterSettle') {
        stats.faultsInjected.dropAfterSettle++;
        return req.socket.destroy();
      }
      if (fault === 'error503AfterSettle') {
        stats.faultsInjected.error503AfterSettle++;
        return respond(503, {}, { error: 'upstream timeout' });
      }
      return respond(200, settlement.headers, body);
    } catch (error) {
      return respond(500, {}, { error: String(error?.message ?? error) });
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    stats,
    reset() {
      seen.clear();
      remembered.clear();
      stats.unpaid = stats.paid = stats.settledBySeller = stats.replays = stats.rejected = 0;
      stats.faultsInjected = { dropAfterSettle: 0, error503AfterSettle: 0, dropBeforeSettle: 0 };
      stats.log = [];
    },
    stop: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
