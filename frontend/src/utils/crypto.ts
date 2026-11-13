/**
 * Zero-Knowledge Client Request Signing and Keypair Management.
 * All cryptographic operations execute exclusively in the client's browser.
 * Private keys are never transmitted to or stored on any server.
 */

export interface TenantKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
  keyId: string;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return window.btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = window.atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const cleanPem = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
    .replace(/\s+/g, '');
  return base64ToArrayBuffer(cleanPem);
}

function formatAsPem(base64: string, label: string): string {
  const lines: string[] = [`-----BEGIN ${label}-----`];
  for (let i = 0; i < base64.length; i += 64) {
    lines.push(base64.substring(i, i + 64));
  }
  lines.push(`-----END ${label}-----`);
  return lines.join('\n');
}

/**
 * Generates an RSA-2048 keypair using the standard Web Cryptography API.
 */
export async function generateClientKeyPair(keyId: string = 'client_key_1'): Promise<TenantKeyPair> {
  const keyPair = await window.crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );

  const exportedPublic = await window.crypto.subtle.exportKey('spki', keyPair.publicKey);
  const exportedPrivate = await window.crypto.subtle.exportKey('pkcs8', keyPair.privateKey);

  const publicKeyPem = formatAsPem(arrayBufferToBase64(exportedPublic), 'PUBLIC KEY');
  const privateKeyPem = formatAsPem(arrayBufferToBase64(exportedPrivate), 'PRIVATE KEY');

  return {
    publicKeyPem,
    privateKeyPem,
    keyId,
  };
}

/**
 * Signs a client request using the tenant private key.
 * Format:
 * <METHOD>\n<PATH>\n<TIMESTAMP>\n<NONCE>\n<SHA256_HEX(BODY)>
 */
export async function signClientRequest(params: {
  method: string;
  path: string;
  body?: unknown;
  privateKeyPem: string;
  keyId: string;
}): Promise<{
  'X-Signature': string;
  'X-Key-Id': string;
  'X-Timestamp': string;
  'X-Nonce': string;
}> {
  const { method, path, body, privateKeyPem, keyId } = params;
  const timestamp = Date.now().toString();
  const nonce = window.crypto.randomUUID();

  // Compute SHA-256 hash of request body
  const bodyString = body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : '';
  const bodyEncoded = new TextEncoder().encode(bodyString);
  const hashBuffer = await window.crypto.subtle.digest('SHA-256', bodyEncoded);

  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const bodyHashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

  const canonicalString = `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodyHashHex}`;
  const canonicalBytes = new TextEncoder().encode(canonicalString);

  // Import PKCS8 private key
  const privateKeyBuffer = pemToArrayBuffer(privateKeyPem);
  const cryptoKey = await window.crypto.subtle.importKey(
    'pkcs8',
    privateKeyBuffer,
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    false,
    ['sign']
  );

  // Sign canonical string
  const signatureBuffer = await window.crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, canonicalBytes);
  const signatureBase64 = arrayBufferToBase64(signatureBuffer);

  return {
    'X-Signature': signatureBase64,
    'X-Key-Id': keyId,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
  };
}

const STORAGE_KEY = 'lg_client_keypair';

export function saveStoredKeyPair(keyPair: TenantKeyPair): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(keyPair));
  } catch {
    // Session storage fallback
  }
}

export function getStoredKeyPair(): TenantKeyPair | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
