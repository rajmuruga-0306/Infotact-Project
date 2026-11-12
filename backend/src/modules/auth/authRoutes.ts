import { Router } from 'express';
import {
  registerOrgSchema,
  loginSchema,
  switchOrgSchema,
} from '@ledgerguard/shared';
import { AuthController } from './authController.js';
import { authenticate } from '../../gateway/authenticate.js';
import { authRateLimiter } from '../../gateway/rateLimit.js';
import { csrfProtect } from '../../gateway/csrfProtect.js';
import { validateRequest } from '../../gateway/validate.js';

export function createAuthRouter(
  controller?: AuthController,
  authenticateMiddleware = authenticate,
  limiter = authRateLimiter
): Router {
  const router = Router();
  let resolvedController = controller;
  const getController = () => {
    if (!resolvedController) {
      resolvedController = new AuthController();
    }
    return resolvedController;
  };

  // Public: Register a new organization and admin user (Rate-limited, atomic transaction)
  router.post(
    '/register-org',
    limiter,
    validateRequest({ body: registerOrgSchema }),
    (req, res) => getController().registerOrg(req, res)
  );

  // Public: Log in user (Rate-limited, bcrypt cost 12, issues RS256 token + HttpOnly cookie)
  router.post(
    '/login',
    limiter,
    validateRequest({ body: loginSchema }),
    (req, res) => getController().login(req, res)
  );

  // Public/Cookie: Refresh access token (CSRF protected, atomic Lua rotation with tripwire reuse detection)
  router.post(
    '/refresh',
    csrfProtect,
    (req, res) => getController().refresh(req, res)
  );

  // Authenticated: Logout (Immediate session revocation in Redis, cookie clearing)
  router.post(
    '/logout',
    authenticateMiddleware,
    csrfProtect,
    (req, res) => getController().logout(req, res)
  );

  // Authenticated: Get current user profile and accessible organizations
  router.get(
    '/me',
    authenticateMiddleware,
    (req, res) => getController().getMe(req, res)
  );

  // Authenticated: Switch active organization context (Revokes old family, issues fresh family)
  router.post(
    '/switch-org',
    authenticateMiddleware,
    csrfProtect,
    validateRequest({ body: switchOrgSchema }),
    (req, res) => getController().switchOrg(req, res)
  );

  return router;
}

export const authRoutes = createAuthRouter();
