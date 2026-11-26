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
  const body = new Uint8Array(await request.clone().arrayBuffer());
  const bodyHash = await sha256Hex(body);
  return sha256Hex(encoder.encode(`${request.method.toUpperCase()}\n${request.url}\n${bodyHash}`));
}
