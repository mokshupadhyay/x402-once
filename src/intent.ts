const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  return toHex(await globalThis.crypto.subtle.digest('SHA-256', data as BufferSource));
}

/**
 * The key for one purchase when the caller did not choose it: a hash of the method, the URL and the body.
 * Two identical calls share a key only while the first one is unresolved, so a deliberate second purchase is not blocked.
 */
export async function deriveIntent(request: Request): Promise<string> {
  let body = new Uint8Array(await request.clone().arrayBuffer());
  // Every FormData body gets a fresh random multipart boundary, so the same form would hash differently each time.
  const boundary = /boundary=("?)([^";\s]+)\1/i.exec(request.headers.get('content-type') ?? '')?.[2];
  if (boundary && body.length > 0) {
    const text = new TextDecoder('latin1').decode(body).split(boundary).join('BOUNDARY');
    body = new Uint8Array([...text].map((c) => c.charCodeAt(0)));
  }
  const bodyHash = await sha256Hex(body);
  return sha256Hex(encoder.encode(`${request.method.toUpperCase()}\n${request.url}\n${bodyHash}`));
}
