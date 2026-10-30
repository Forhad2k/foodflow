import type { Server } from 'socket.io';

/** Room names. Membership is ALWAYS decided by the server from the database, never by the client. */
export const rooms = {
  user: (userId: string) => `user:${userId}`,
  tracking: (orderId: string) => `order:${orderId}:tracking`,
  chat: (orderId: string) => `order:${orderId}:chat`,
};

/**
 * The only thing services know about Socket.IO. Until a server is attached (tests, scripts, a pure-HTTP deploy)
 * every method is a harmless no-op, so services never depend on a live socket server.
 */
export class RealtimeHub {
  io?: Server;

  attach(io: Server) {
    this.io = io;
  }
  toUser(userId: string, event: string, payload: unknown) {
    this.io?.to(rooms.user(userId)).emit(event, payload);
  }
  toRoom(room: string, event: string, payload: unknown) {
    this.io?.to(room).emit(event, payload);
  }
  /** Which users currently have a socket in this room. */
  async userIdsIn(room: string): Promise<Set<string>> {
    if (!this.io) return new Set();
    return new Set((await this.io.in(room).fetchSockets()).map((s) => s.data.user?.id).filter(Boolean));
  }
  /** Removes sockets of anyone who is no longer allowed in (e.g. a rider replaced mid-delivery) BEFORE we broadcast. */
  async prune(room: string, allowed: ReadonlySet<string>) {
    if (!this.io) return;
    for (const s of await this.io.in(room).fetchSockets()) if (!allowed.has(s.data.user?.id)) s.leave(room);
  }
}
