import { Router } from 'express';
import { authenticate } from '../../gateway/authenticate.js';
import { tenantContext } from '../../tenancy/tenantContext.js';
import { verifyTenantSignature } from '../../gateway/verifyTenantSignature.js';
import { UsageController, usageController } from './usageController.js';

export function createUsageRouter(controller: UsageController = usageController): Router {
  const router = Router();

  // All usage routes require:
  // 1. Authenticated user session (RS256 access token)
  // 2. Resolved tenant database context (dynamic pool)
  // 3. Cryptographic RSA-SHA256 tenant request signature & anti-replay nonce
  router.use(authenticate);
  router.use(tenantContext);
  router.use(verifyTenantSignature);

  router.post('/record', controller.recordUsage);
  router.post('/batch', controller.recordUsageBatch);
  router.post('/aggregate-and-settle', controller.aggregateAndSettle);
  router.get('/analytics', controller.getAnalytics);
  router.get('/records', controller.getUsageRecords);
  router.get('/pricing-plans', controller.getPricingPlans);
  router.get('/audit-logs', controller.getTenantAuditLogs);

  return router;
}

export const usageRouter = createUsageRouter();
