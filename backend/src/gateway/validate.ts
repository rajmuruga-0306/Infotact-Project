import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';

export interface ValidationSchemas {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}

/**
 * Generic request validation middleware wrapping Zod schemas.
 * Strips unknown fields and returns standardized error responses on schema violation.
 */
export function validateRequest(schemas: ValidationSchemas) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = req.requestId || 'unknown';

    try {
      if (schemas.body) {
        req.body = schemas.body.parse(req.body);
      }
      if (schemas.query) {
        req.query = schemas.query.parse(req.query);
      }
      if (schemas.params) {
        req.params = schemas.params.parse(req.params);
      }
      next();
    } catch (err: unknown) {
      if (err instanceof ZodError) {
        const issues = err.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        }));
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: issues.map((i) => `${i.field}: ${i.message}`).join('; '),
            requestId,
            details: issues,
          },
        });
        return;
      }

      res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'Failed to process request data',
          requestId,
        },
      });
    }
  };
}
