import { Request, Response, NextFunction } from 'express';
import { Connection } from 'mongoose';
import { getControlModels, IOrganization } from '../models/control/index.js';
import { TenantModels } from '../models/tenant/index.js';
import { tenantConnectionManager, TenantConnectionManager } from './tenantConnectionManager.js';

export interface TenantContext {
  org: IOrganization;
  dbConn: Connection;
  models: TenantModels;
}

// Extend Express Request interface to include tenant context
declare global {
  namespace Express {
    interface Request {
      tenant?: TenantContext;
    }
  }
}

export interface TenantContextMiddlewareOptions {
  connectionManager?: TenantConnectionManager;
  controlDbConn?: Connection;
}

/**
 * Middleware that resolves the active tenant organization from req.auth.orgId,
 * acquires/pools the tenant's isolated MongoDB database connection,
 * and attaches { org, dbConn, models } to req.tenant.
 * Automatically releases the connection in-flight counter upon HTTP response finish.
 */
export function createTenantContextMiddleware(options: TenantContextMiddlewareOptions = {}) {
  const manager = options.connectionManager || tenantConnectionManager;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const requestId = req.requestId || 'unknown';

    if (!req.auth?.orgId) {
      res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication context with active orgId is required',
          requestId,
        },
      });
      return;
    }

    const orgId = req.auth.orgId;

    try {
      // 1. Resolve Organization from control DB
      const controlModels = getControlModels(options.controlDbConn);
      const org = await controlModels.Organization.findById(orgId);

      if (!org) {
        res.status(404).json({
          error: {
            code: 'TENANT_NOT_FOUND',
            message: `Organization '${orgId}' not found`,
            requestId,
          },
        });
        return;
      }

      if (org.status !== 'ACTIVE') {
        res.status(403).json({
          error: {
            code: 'TENANT_SUSPENDED',
            message: `Organization '${org.slug}' is currently ${org.status.toLowerCase()}`,
            requestId,
          },
        });
        return;
      }

      // 2. Acquire isolated tenant database connection from pool
      const pooled = await manager.acquireConnection(org);

      // 3. Attach tenant context to request
      req.tenant = {
        org,
        dbConn: pooled.conn,
        models: pooled.models,
      };

      // 4. Hook response cleanup to decrement active in-flight operations
      let released = false;
      const releaseOnce = () => {
        if (!released) {
          released = true;
          manager.releaseConnection(orgId);
        }
      };

      res.on('finish', releaseOnce);
      res.on('close', releaseOnce);

      next();
    } catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.error(`[TenantContext Error for org '${orgId}']`, err);
      res.status(500).json({
        error: {
          code: 'TENANT_CONNECTION_ERROR',
          message: err instanceof Error ? err.message : 'Failed to connect to tenant database',
          requestId,
        },
      });
    }
  };
}

export const tenantContext = createTenantContextMiddleware();
