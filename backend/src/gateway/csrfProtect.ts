import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';

/**
 * Returns standard cookie configuration for refresh tokens.
 *
 * PRODUCTION ARCHITECTURE & THIRD-PARTY COOKIE ADVISORY:
 * Modern browsers (Safari ITP, Chrome Privacy Sandbox, Firefox ETP) block or partition
 * cross-site third-party cookies by default (e.g., frontend on vercel.app calling backend on render.com).
 * For 100% reliable production delivery, custom domains sharing a common eTLD+1 are recommended:
 * e.g., app.ledgerguard.com (frontend) and api.ledgerguard.com (API gateway), using SameSite: 'lax' and Domain: '.ledgerguard.com'.
 *
 * Fallback cross-site configuration (when custom domain is absent):
 * Uses Secure=true and SameSite='none'.
 *
 * In local development:
 * Uses Secure=false and SameSite='lax' (for localhost HTTP).
 */
export function getRefreshTokenCookieOptions(domainOverride?: string) {
  const isProd = process.env.NODE_ENV === 'production';
  const cookieDomain = domainOverride || process.env.COOKIE_DOMAIN;

  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? (cookieDomain ? ('lax' as const) : ('none' as const)) : ('lax' as const),
    path: '/api/v1/auth',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
    ...(cookieDomain ? { domain: cookieDomain } : {}),
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
