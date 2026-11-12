import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Generates an RSA-2048 keypair for a tenant organization (RS256 request signing).
 *
 * ZERO-KNOWLEDGE PRINCIPLE:
 * The tenant private key is stored ONLY on the tenant's local machine.
 * It is NEVER transmitted to the LedgerGuard server, MongoDB, or Redis.
 */
function generateTenantKeys(): void {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem',
    },
  });

  // eslint-disable-next-line no-console
  console.log('\n===============================================================');
  // eslint-disable-next-line no-console
  console.log('       LEDGERGUARD TENANT RSA-256 KEYPAIR GENERATOR');
  // eslint-disable-next-line no-console
  console.log('===============================================================\n');

  // eslint-disable-next-line no-console
  console.log('1. TENANT PUBLIC KEY (Send this to POST /api/v1/auth/register-org):');
  // eslint-disable-next-line no-console
  console.log('---------------------------------------------------------------');
  // eslint-disable-next-line no-console
  console.log(publicKey.trim());
  // eslint-disable-next-line no-console
  console.log('---------------------------------------------------------------\n');

  // eslint-disable-next-line no-console
  console.log('2. TENANT PRIVATE KEY (STORE SECURELY ON CLIENT MACHINE):');
  // eslint-disable-next-line no-console
  console.log('---------------------------------------------------------------');
  // eslint-disable-next-line no-console
  console.log(privateKey.trim());
  // eslint-disable-next-line no-console
  console.log('---------------------------------------------------------------\n');

  // Optionally save to local ignored file if not present
  const outPath = resolve(process.cwd(), 'tenant-private-key.pem');
  if (!existsSync(outPath)) {
    try {
      writeFileSync(outPath, privateKey, { mode: 0o600 });
      // eslint-disable-next-line no-console
      console.log(`[+] Saved private key locally to: ${outPath} (Git-ignored)`);
    } catch {
      // Ignore if write restricted
    }
  }

  // eslint-disable-next-line no-console
  console.log('\nCRITICAL ZERO-TRUST RULE:');
  // eslint-disable-next-line no-console
  console.log('NEVER send this private key in any HTTP request, email, or chat.');
  // eslint-disable-next-line no-console
  console.log('LedgerGuard verifies signatures with only your public key.');
  // eslint-disable-next-line no-console
  console.log('===============================================================\n');
}

generateTenantKeys();
