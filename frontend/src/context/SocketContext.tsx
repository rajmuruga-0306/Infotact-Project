import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from './AuthContext';
import {
  SOCKET_EVENTS,
  ServerToClientEvents,
  ClientToServerEvents,
  LimitWarningPayload,
  SecurityAlertPayload,
  TransactionSucceededPayload,
  TransactionFailedPayload,
  UsageUpdatedPayload,
} from '@ledgerguard/shared';

export interface DashboardAlert {
  id: string;
  type: 'limit' | 'security' | 'info';
  severity: 'low' | 'medium' | 'high' | 'critical' | 'warning';
  title: string;
  message: string;
  timestamp: string;
}

interface SocketContextType {
  isConnected: boolean;
  alerts: DashboardAlert[];
  dismissAlert: (id: string) => void;
  clearAlerts: () => void;
  lastEvent: { name: string; timestamp: string } | null;
}

const SocketContext = createContext<SocketContextType | undefined>(undefined);

export const SocketProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { accessToken, currentOrg } = useAuth();
  const queryClient = useQueryClient();
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [alerts, setAlerts] = useState<DashboardAlert[]>([]);
  const [lastEvent, setLastEvent] = useState<{ name: string; timestamp: string } | null>(null);
  const socketRef = useRef<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null);

  const dismissAlert = useCallback((id: string) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const clearAlerts = useCallback(() => {
    setAlerts([]);
  }, []);

  useEffect(() => {
    if (!accessToken || !currentOrg) {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      setIsConnected(false);
      return;
    }

    // Connect to WebSocket server using current JWT token
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io('/', {
      auth: { token: accessToken },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 15,
      reconnectionDelay: 1000,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setIsConnected(true);
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
    });

    // 1. Transaction posted / succeeded
    const handleTransactionSucceeded = (_payload: TransactionSucceededPayload) => {
      setLastEvent({ name: 'transaction:posted', timestamp: new Date().toISOString() });
      // Invalidate relevant react-query caches for instant real-time update
      queryClient.invalidateQueries({ queryKey: ['balance'] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['analytics'] });
    };

    socket.on(SOCKET_EVENTS.TRANSACTION_POSTED, handleTransactionSucceeded);
    socket.on(SOCKET_EVENTS.TRANSACTION_SUCCEEDED, handleTransactionSucceeded);

    // 2. Transaction failed
    socket.on(SOCKET_EVENTS.TRANSACTION_FAILED, (payload: TransactionFailedPayload) => {
      setLastEvent({ name: 'transaction:failed', timestamp: new Date().toISOString() });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['analytics'] });

      setAlerts((prev) => [
        {
          id: `tx-fail-${Date.now()}-${Math.random()}`,
          type: 'security',
          severity: 'high',
          title: 'Transaction Failed',
          message: payload.failureReason || 'A ledger transaction could not be posted.',
          timestamp: payload.failedAt || new Date().toISOString(),
        },
        ...prev.slice(0, 9),
      ]);
    });

    // 3. Limit Warning (Monthly quota >= 80%)
    socket.on(SOCKET_EVENTS.LIMIT_WARNING, (payload: LimitWarningPayload) => {
      setLastEvent({ name: 'limit:warning', timestamp: new Date().toISOString() });
      queryClient.invalidateQueries({ queryKey: ['balance'] });
      queryClient.invalidateQueries({ queryKey: ['analytics'] });

      const isCritical = payload.percentUsed >= 90;
      setAlerts((prev) => [
        {
          id: `limit-warn-${Date.now()}`,
          type: 'limit',
          severity: isCritical ? 'critical' : 'warning',
          title: `Monthly Quota Alert (${payload.percentUsed}%)`,
          message: `Current spend is $${(payload.currentSpendMinor / 100).toFixed(2)} of $${(
            payload.monthlyLimitMinor / 100
          ).toFixed(2)} monthly budget limit.`,
          timestamp: payload.warnedAt || new Date().toISOString(),
        },
        ...prev.filter((a) => !a.id.startsWith('limit-warn-')).slice(0, 9),
      ]);
    });

    // 4. Security Alert (Replay attack, Invalid signature, etc.)
    socket.on(SOCKET_EVENTS.SECURITY_ALERT, (payload: SecurityAlertPayload) => {
      setLastEvent({ name: 'security:alert', timestamp: new Date().toISOString() });

      setAlerts((prev) => [
        {
          id: `sec-alert-${Date.now()}-${Math.random()}`,
          type: 'security',
          severity: payload.severity || 'high',
          title: `Security Alert: ${payload.type.replace(/_/g, ' ')}`,
          message: payload.message,
          timestamp: payload.occurredAt || new Date().toISOString(),
        },
        ...prev.slice(0, 9),
      ]);
    });

    // 5. Usage Updated
    socket.on(SOCKET_EVENTS.USAGE_UPDATED, (_payload: UsageUpdatedPayload) => {
      setLastEvent({ name: 'usage:updated', timestamp: new Date().toISOString() });
      queryClient.invalidateQueries({ queryKey: ['usageRecords'] });
      queryClient.invalidateQueries({ queryKey: ['analytics'] });
    });

    return () => {
      socket.disconnect();
    };
  }, [accessToken, currentOrg, queryClient]);

  return (
    <SocketContext.Provider
      value={{
        isConnected,
        alerts,
        dismissAlert,
        clearAlerts,
        lastEvent,
      }}
    >
      {children}
    </SocketContext.Provider>
  );
};

export function useSocket(): SocketContextType {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error('useSocket must be used within a SocketProvider');
  }
  return context;
}
