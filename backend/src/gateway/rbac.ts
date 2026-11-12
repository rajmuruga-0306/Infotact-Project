import { Request, Response, NextFunction } from 'express';
import { UserRole } from '@ledgerguard/shared';

/**
 * Role-Based Access Control (RBAC) middleware.
 * Verifies that the authenticated user possesses one of the allowed roles.
 */
export function requireRole(...allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = req.requestId || 'unknown';

    if (!req.auth) {
      res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required prior to role authorization',
          requestId,
        },
      });
      return;
    }

    if (!allowedRoles.includes(req.auth.role)) {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: `Forbidden: role '${req.auth.role}' is not authorized for this resource`,
          requestId,
        },
      });
      return;
    }

    next();
  };
}
