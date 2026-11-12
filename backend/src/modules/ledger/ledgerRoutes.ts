import { Router } from 'express';
import { authenticate } from '../../gateway/authenticate.js';
import { tenantContext } from '../../tenancy/tenantContext.js';
import { verifyTenantSignature } from '../../gateway/verifyTenantSignature.js';
import { LedgerController, ledgerController } from './ledgerController.js';

export function createLedgerRouter(controller: LedgerController = ledgerController): Router {
  const router = Router();

  // All ledger routes require:
  // 1. Authenticated user session (RS256 access token)
  // 2. Resolved tenant database context (dynamic pool)
  // 3. Cryptographic RSA-SHA256 tenant request signature & anti-replay nonce
  router.use(authenticate);
  router.use(tenantContext);
  router.use(verifyTenantSignature);

  router.post('/transactions', controller.createTransaction);
  router.get('/transactions', controller.getTransactions);
  router.get('/transactions/:id', controller.getTransactionById);
  router.get('/balance', controller.getBalance);

  return router;
}

export const ledgerRouter = createLedgerRouter();
