import { generateKeyPairSync } from 'node:crypto';

/**
 * Generates an RSA-2048 keypair for the API Gateway to sign and verify RS256 JWTs.
 * Outputs the keys as Base64-encoded PEM strings suitable for environment variables.
 */
function generateGatewayKeys(): void {
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

  const privateKeyBase64 = Buffer.from(privateKey).toString('base64');
  const publicKeyBase64 = Buffer.from(publicKey).toString('base64');

  // eslint-disable-next-line no-console
  console.log('\n===============================================================');
  // eslint-disable-next-line no-console
  console.log('   LEDGERGUARD API GATEWAY RS256 KEYPAIR GENERATED');
  // eslint-disable-next-line no-console
  console.log('===============================================================\n');

  // eslint-disable-next-line no-console
  console.log('Add the following variables to your backend/.env file:\n');
  // eslint-disable-next-line no-console
  console.log(`JWT_KEY_ID=lg-gw-1`);
  // eslint-disable-next-line no-console
  console.log(`JWT_PRIVATE_KEY=${privateKeyBase64}`);
  // eslint-disable-next-line no-console
  console.log(`JWT_PUBLIC_KEY=${publicKeyBase64}\n`);

  // eslint-disable-next-line no-console
  console.log('---------------------------------------------------------------');
  // eslint-disable-next-line no-console
  console.log('SECURITY WARNING:');
  // eslint-disable-next-line no-console
  console.log('- Store JWT_PRIVATE_KEY in deployment secrets only.');
  // eslint-disable-next-line no-console
  console.log('- NEVER commit .env or the private key to GitHub.');
  // eslint-disable-next-line no-console
  console.log('===============================================================\n');
}

generateGatewayKeys();
