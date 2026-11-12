import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';

/**
 * Returns standard cookie configuration for refresh tokens.
 * In production: Secure=true and SameSite=none (for cross-origin frontend-backend deployment).
 * In local development: Secure=false and SameSite=lax (for localhost HTTP development).
 */
export function getRefreshTokenCookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? ('none' as const) : ('lax' as const),
    path: '/api/v1/auth',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
  };
}

/**
 * CSRF defense middleware for cookie-authenticated mutation endpoints.
 * Validates Origin header against CORS_ORIGINS and verifies the presence of
 * a custom CSRF header that cross-site form submissions cannot forge.
 */
export function csrfProtect(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.requestId || 'unknown';

  // 1. Origin header verification
  const origin = req.headers.origin;
  if (origin && !env.CORS_ORIGINS.includes(origin)) {
    res.status(403).json({
      error: {
        code: 'CSRF_ORIGIN_INVALID',
        message: `Cross-site request origin '${origin}' is not authorized`,
        requestId,
      },
    });
    return;
  }

  // 2. Custom header check (X-Requested-With or X-CSRF-Protection)
  // Cross-origin HTML forms / simple requests cannot attach custom headers
  const customHeader = req.headers['x-requested-with'] || req.headers['x-csrf-protection'];
  if (!customHeader) {
    res.status(403).json({
      error: {
        code: 'CSRF_HEADER_MISSING',
        message: 'Security validation failed: X-Requested-With or X-CSRF-Protection header required',
        requestId,
      },
    });
    return;
  }

  next();
}
