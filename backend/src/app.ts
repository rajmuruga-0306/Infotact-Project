import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { env } from './config/env.js';

// Extend Express Request type to include rawBody and requestId
declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
      requestId?: string;
    }
  }
}

export const app = express();

// Security headers via Helmet
app.use(helmet());

// Strict CORS allowlist
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow server-to-server or curl/mobile requests without Origin header
      if (!origin) {
        return callback(null, true);
      }
      if (env.CORS_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`Origin '${origin}' not allowed by CORS policy`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Signature',
      'X-Key-Id',
      'X-Timestamp',
      'X-Nonce',
      'X-Simulate-Failure',
    ],
  })
);

// Assign unique requestId to every request
app.use((req: Request, _res: Response, next: NextFunction) => {
  req.requestId = randomUUID();
  next();
});

// JSON body parser with raw body buffer preservation for cryptographic signature verification
app.use(
  express.json({
    limit: '1mb',
    verify: (req: Request, _res: Response, buf: Buffer) => {
      req.rawBody = buf;
    },
  })
);

// Basic health check route
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Standard Error Handler conforming to API contract
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  const requestId = req.requestId || 'unknown';
  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: err.message || 'An unexpected error occurred',
      requestId,
    },
  });
});
