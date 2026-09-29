/**
 * Issue #852 — request-signing helper for mutating API routes.
 *
 * Produces the X-SSB-* headers the indexer verifies:
 *   signature = HMAC-SHA256(secret, METHOD \n PATH \n SHA256(body) \n timestamp \n nonce)
 *
 * `body` must be the exact string sent on the wire — sign it, then send that
 * same string unchanged. `path` includes the query string.
 */

export interface SignRequestInput {
  keyId: string;
  secret: string;
  method: string;
  path: string;
  body?: string;
  /** Unix seconds; defaults to now. Pass `server_time` from a stale_timestamp 401 to correct clock skew. */
  timestamp?: number;
  nonce?: string;
}

const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toHex(bytes.buffer);
}

export async function signRequest(input: SignRequestInput): Promise<Record<string, string>> {
  const timestamp = String(input.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = input.nonce ?? randomNonce();
  const bodyHash = toHex(await crypto.subtle.digest('SHA-256', encoder.encode(input.body ?? '')));
  const canonical = [input.method.toUpperCase(), input.path, bodyHash, timestamp, nonce].join('\n');
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(input.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(canonical)));
  return {
    'X-SSB-Key-Id': input.keyId,
    'X-SSB-Timestamp': timestamp,
    'X-SSB-Nonce': nonce,
    'X-SSB-Signature': signature,
  };
}
