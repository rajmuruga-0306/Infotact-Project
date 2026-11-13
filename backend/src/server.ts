import { createServer } from 'node:http';
import { app } from './app.js';
import { env } from './config/env.js';
import { initSocketServer } from './websocket/index.js';

const httpServer = createServer(app);
initSocketServer(httpServer);

const server = httpServer.listen(env.PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`[LedgerGuard] Server & WebSockets listening on http://0.0.0.0:${env.PORT} (NODE_ENV=${env.NODE_ENV})`);
});

// Graceful shutdown handling
const handleShutdown = (signal: string) => {
  // eslint-disable-next-line no-console
  console.log(`[LedgerGuard] Received ${signal}. Closing HTTP server...`);
  server.close(() => {
    // eslint-disable-next-line no-console
    console.log('[LedgerGuard] HTTP server closed gracefully.');
    process.exit(0);
  });

  // Force close if graceful termination hangs
  setTimeout(() => {
    // eslint-disable-next-line no-console
    console.error('[LedgerGuard] Forced shutdown after timeout.');
    process.exit(1);
  }, 10000).unref();
};

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));
