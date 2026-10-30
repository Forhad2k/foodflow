'use client';
import { io, Socket } from 'socket.io-client';
import { api } from './api';
import type { ChatMessage, NotificationItem, TrackingLocation } from './types';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

class RealtimeClient {
  private socket: Socket | null = null;
  private connecting = false;

  get currentSocket(): Socket | null {
    return this.socket;
  }

  connect(): Socket | null {
    const token = api.accessToken;
    if (!token) {
      if (this.socket) {
        this.socket.disconnect();
        this.socket = null;
      }
      return null;
    }

    if (this.socket && this.socket.connected) {
      return this.socket;
    }

    if (this.connecting && this.socket) {
      return this.socket;
    }

    this.connecting = true;
    this.socket = io(API_URL, {
      auth: { token },
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });

    this.socket.on('connect', () => {
      this.connecting = false;
    });

    this.socket.on('connect_error', async (err) => {
      this.connecting = false;
      if (err.message === 'UNAUTHORIZED') {
        const refreshed = await api.refresh();
        if (refreshed && this.socket) {
          this.socket.auth = { token: refreshed.accessToken };
          this.socket.connect();
        }
      }
    });

    this.socket.on('auth:expired', async () => {
      const refreshed = await api.refresh();
      if (refreshed && this.socket) {
        this.socket.auth = { token: refreshed.accessToken };
        this.socket.connect();
      } else {
        this.disconnect();
      }
    });

    this.socket.on('disconnect', () => {
      this.connecting = false;
    });

    return this.socket;
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.connecting = false;
  }

  // ── Notifications ──
  syncNotifications(): Promise<{ ok: boolean; unreadCount?: number }> {
    return new Promise((resolve) => {
      const s = this.connect();
      if (!s) return resolve({ ok: false });
      s.emit('notifications:sync', {}, (res: { ok: boolean; unreadCount?: number }) => {
        resolve(res ?? { ok: false });
      });
    });
  }

  onNotification(handler: (n: NotificationItem & { unreadCount?: number }) => void): () => void {
    const s = this.connect();
    if (!s) return () => undefined;
    s.on('notification', handler);
    return () => {
      s.off('notification', handler);
    };
  }

  // ── Tracking ──
  subscribeTracking(orderId: string): Promise<{ ok: boolean; location?: TrackingLocation | null; staleAfterSeconds?: number; error?: { code: string; message: string } }> {
    return new Promise((resolve) => {
      const s = this.connect();
      if (!s) return resolve({ ok: false });
      s.emit('tracking:subscribe', { orderId }, (res: { ok: boolean; location?: TrackingLocation | null; staleAfterSeconds?: number; error?: { code: string; message: string } }) => {
        resolve(res ?? { ok: false });
      });
    });
  }

  unsubscribeTracking(orderId: string) {
    if (this.socket?.connected) {
      this.socket.emit('tracking:unsubscribe', { orderId });
    }
  }

  sendRiderLocation(payload: { orderId: string; lat: number; lng: number; headingDeg?: number; speedMps?: number; accuracyM?: number }): Promise<{ ok: boolean; error?: { code: string; message: string } }> {
    return new Promise((resolve) => {
      const s = this.connect();
      if (!s) return resolve({ ok: false });
      s.emit('rider:location', payload, (res: { ok: boolean; error?: { code: string; message: string } }) => {
        resolve(res ?? { ok: false });
      });
    });
  }

  onTrackingLocation(handler: (loc: TrackingLocation) => void): () => void {
    const s = this.connect();
    if (!s) return () => undefined;
    s.on('tracking:location', handler);
    return () => {
      s.off('tracking:location', handler);
    };
  }

  onTrackingStale(handler: (data: { orderId: string; lastUpdateAt: string }) => void): () => void {
    const s = this.connect();
    if (!s) return () => undefined;
    s.on('tracking:stale', handler);
    return () => {
      s.off('tracking:stale', handler);
    };
  }

  onTrackingFresh(handler: (data: { orderId: string }) => void): () => void {
    const s = this.connect();
    if (!s) return () => undefined;
    s.on('tracking:fresh', handler);
    return () => {
      s.off('tracking:fresh', handler);
    };
  }

  onTrackingRiderDisconnected(handler: (data: { orderId: string; at: string }) => void): () => void {
    const s = this.connect();
    if (!s) return () => undefined;
    s.on('tracking:rider_disconnected', handler);
    return () => {
      s.off('tracking:rider_disconnected', handler);
    };
  }

  onTrackingEnded(handler: (data: { orderId: string; reason: string }) => void): () => void {
    const s = this.connect();
    if (!s) return () => undefined;
    s.on('tracking:ended', handler);
    return () => {
      s.off('tracking:ended', handler);
    };
  }

  // ── Chat ──
  joinChat(orderId: string): Promise<{ ok: boolean; messages?: ChatMessage[]; hasMore?: boolean; unread?: number; room?: { open: boolean; orderNumber: string }; error?: { code: string; message: string } }> {
    return new Promise((resolve) => {
      const s = this.connect();
      if (!s) return resolve({ ok: false });
      s.emit('chat:join', { orderId }, (res: { ok: boolean; messages?: ChatMessage[]; hasMore?: boolean; unread?: number; room?: { open: boolean; orderNumber: string }; error?: { code: string; message: string } }) => {
        resolve(res ?? { ok: false });
      });
    });
  }

  leaveChat(orderId: string) {
    if (this.socket?.connected) {
      this.socket.emit('chat:leave', { orderId });
    }
  }

  sendChatMessage(orderId: string, body: string, clientMessageId?: string): Promise<{ ok: boolean; message?: ChatMessage; duplicate?: boolean; error?: { code: string; message: string } }> {
    return new Promise((resolve) => {
      const s = this.connect();
      if (!s) return resolve({ ok: false });
      s.emit('chat:send', { orderId, body, clientMessageId: clientMessageId ?? `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}` }, (res: { ok: boolean; message?: ChatMessage; duplicate?: boolean; error?: { code: string; message: string } }) => {
        resolve(res ?? { ok: false });
      });
    });
  }

  readChat(orderId: string, upToMessageId?: string): Promise<{ ok: boolean; marked?: number }> {
    return new Promise((resolve) => {
      const s = this.connect();
      if (!s) return resolve({ ok: false });
      s.emit('chat:read', { orderId, upToMessageId }, (res: { ok: boolean; marked?: number }) => {
        resolve(res ?? { ok: false });
      });
    });
  }

  onChatMessage(handler: (msg: ChatMessage) => void): () => void {
    const s = this.connect();
    if (!s) return () => undefined;
    s.on('chat:message', handler);
    return () => {
      s.off('chat:message', handler);
    };
  }

  onChatDelivered(handler: (data: { messageId: string; deliveredAt: string }) => void): () => void {
    const s = this.connect();
    if (!s) return () => undefined;
    s.on('chat:delivered', handler);
    return () => {
      s.off('chat:delivered', handler);
    };
  }

  onChatRead(handler: (data: { readerId: string; upToMessageId?: string; readAt: string }) => void): () => void {
    const s = this.connect();
    if (!s) return () => undefined;
    s.on('chat:read', handler);
    return () => {
      s.off('chat:read', handler);
    };
  }
}

export const realtime = new RealtimeClient();

