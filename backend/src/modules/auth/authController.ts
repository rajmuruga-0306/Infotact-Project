import { Request, Response } from 'express';
import { AuthService } from './authService.js';
import { getRefreshTokenCookieOptions } from '../../gateway/csrfProtect.js';

export class AuthController {
  private service: AuthService;

  constructor(service?: AuthService) {
    this.service = service || new AuthService();
  }

  registerOrg = async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId || 'unknown';
    const clientIp = req.ip || '127.0.0.1';

    try {
      const result = await this.service.registerOrg(req.body, clientIp, requestId);
      res.status(201).json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Registration failed';
      if (message.includes('ALREADY_EXISTS')) {
        res.status(409).json({
          error: {
            code: message.includes('SLUG') ? 'SLUG_ALREADY_EXISTS' : 'EMAIL_ALREADY_EXISTS',
            message,
            requestId,
          },
        });
        return;
      }

      res.status(400).json({
        error: {
          code: 'REGISTRATION_FAILED',
          message,
          requestId,
        },
      });
    }
  };

  login = async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId || 'unknown';
    const clientIp = req.ip || '127.0.0.1';

    try {
      const { refreshToken, ...responseBody } = await this.service.login(req.body, clientIp, requestId);

      // Set HttpOnly, Secure, SameSite refresh token cookie
      res.cookie('refreshToken', refreshToken, getRefreshTokenCookieOptions());

      res.status(200).json(responseBody);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Login failed';
      const isAuthError = message.includes('INVALID_CREDENTIALS') || message.includes('USER_INACTIVE');

      res.status(isAuthError ? 401 : 400).json({
        error: {
          code: isAuthError ? 'UNAUTHORIZED' : 'LOGIN_FAILED',
          message,
          requestId,
        },
      });
    }
  };

  refresh = async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId || 'unknown';
    const clientIp = req.ip || '127.0.0.1';

    // Extract refresh token from HttpOnly cookie or fallback request body
    const refreshToken = (req.cookies as Record<string, string> | undefined)?.refreshToken || req.body?.refreshToken;

    if (!refreshToken) {
      res.status(401).json({
        error: {
          code: 'MISSING_REFRESH_TOKEN',
          message: 'Refresh token cookie or body payload is required',
          requestId,
        },
      });
      return;
    }

    try {
      const { newRefreshToken, ...responseBody } = await this.service.refresh(refreshToken, clientIp, requestId);

      // Update HttpOnly cookie with freshly rotated token
      res.cookie('refreshToken', newRefreshToken, getRefreshTokenCookieOptions());

      res.status(200).json(responseBody);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Token refresh failed';
      // Clear compromised/invalid cookie
      res.clearCookie('refreshToken', { path: '/api/v1/auth' });

      res.status(401).json({
        error: {
          code: message.includes('REUSE_DETECTED') ? 'TOKEN_REUSE_DETECTED' : 'UNAUTHORIZED',
          message,
          requestId,
        },
      });
    }
  };

  logout = async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId || 'unknown';
    const clientIp = req.ip || '127.0.0.1';
    const familyId = req.auth?.familyId;
    const refreshToken = (req.cookies as Record<string, string> | undefined)?.refreshToken || req.body?.refreshToken;

    if (familyId) {
      await this.service.logout(familyId, clientIp, requestId, refreshToken);
    }

    // Clear refresh token cookie on client
    res.clearCookie('refreshToken', { path: '/api/v1/auth' });

    res.status(200).json({
      message: 'Logged out successfully. Active sessions revoked.',
      requestId,
    });
  };

  switchOrg = async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId || 'unknown';
    const clientIp = req.ip || '127.0.0.1';

    if (!req.auth) {
      res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required', requestId },
      });
      return;
    }

    try {
      const { refreshToken, ...responseBody } = await this.service.switchOrg(
        req.body,
        req.auth.userId,
        req.auth.familyId,
        clientIp,
        requestId
      );

      // Set new refresh token cookie for the new organization session
      res.cookie('refreshToken', refreshToken, getRefreshTokenCookieOptions());

      res.status(200).json(responseBody);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to switch organization';
      const isForbidden = message.includes('FORBIDDEN');

      res.status(isForbidden ? 403 : 400).json({
        error: {
          code: isForbidden ? 'FORBIDDEN' : 'SWITCH_ORG_FAILED',
          message,
          requestId,
        },
      });
    }
  };

  getMe = async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId || 'unknown';

    if (!req.auth) {
      res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required', requestId },
      });
      return;
    }

    try {
      const result = await this.service.getMe(req.auth.userId, req.auth.orgId);
      res.status(200).json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to retrieve profile';
      res.status(404).json({
        error: { code: 'NOT_FOUND', message, requestId },
      });
    }
  };
}
