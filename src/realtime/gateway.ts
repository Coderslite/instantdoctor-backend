import type { Server as HttpServer } from 'node:http';
import { and, eq, or } from 'drizzle-orm';
import { Server, type Socket } from 'socket.io';
import { corsOrigin } from '../config/env.js';
import { db } from '../db/client.js';
import { appointments, users } from '../db/schema/index.js';
import { logger } from '../lib/logger.js';
import { verifyAccessToken } from '../lib/tokens.js';

/**
 * Socket.IO gateway — the replacement for Firestore `snapshots()` streams.
 *
 * Rooms:
 *  - `user:{id}`          joined automatically; personal events (notifications, appointment updates)
 *  - `appointment:{id}`   joined on demand by participants; chat events
 *
 * Server -> client events are listed in `RealtimeEvents`.
 */
export interface RealtimeEvents {
  'notification:new': { id: string; type: string; title: string; createdAt: Date };
  'appointment:updated': { id: string; status: string; isPaid: boolean };
  'message:new': Record<string, unknown>;
  'message:updated': Record<string, unknown>;
  'messages:read': { appointmentId: string; readerId: string };
  'payment:updated': { reference: string; status: string; purpose: string };
  'presence:changed': { userId: string; presence: 'online' | 'offline' };
}

let io: Server | null = null;

const userRoom = (id: string) => `user:${id}`;
const appointmentRoom = (id: string) => `appointment:${id}`;

export function initRealtime(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: { origin: corsOrigin },
  });

  io.use((socket, next) => {
    try {
      const token =
        (socket.handshake.auth as { token?: string }).token ??
        socket.handshake.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (!token) return next(new Error('UNAUTHORIZED'));
      const claims = verifyAccessToken(token);
      socket.data.userId = claims.sub;
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket) => onConnection(socket).catch((err) => logger.error({ err }, 'Socket error')));
  return io;
}

async function onConnection(socket: Socket) {
  const userId = socket.data.userId as string;
  await socket.join(userRoom(userId));
  await setPresence(userId, 'online');

  socket.on('appointment:join', async (appointmentId: unknown, ack?: (res: { ok: boolean }) => void) => {
    const ok = typeof appointmentId === 'string' && (await isParticipant(appointmentId, userId));
    if (ok) await socket.join(appointmentRoom(appointmentId));
    ack?.({ ok });
  });

  socket.on('appointment:leave', (appointmentId: unknown) => {
    if (typeof appointmentId === 'string') void socket.leave(appointmentRoom(appointmentId));
  });

  socket.on('disconnect', async () => {
    const remaining = await io?.in(userRoom(userId)).fetchSockets();
    if (!remaining?.length) await setPresence(userId, 'offline');
  });
}

async function isParticipant(appointmentId: string, userId: string) {
  const [row] = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        eq(appointments.id, appointmentId),
        or(eq(appointments.userId, userId), eq(appointments.doctorId, userId)),
      ),
    )
    .limit(1);
  return Boolean(row);
}

async function setPresence(userId: string, presence: 'online' | 'offline') {
  await db.update(users).set({ presence, lastSeenAt: new Date() }).where(eq(users.id, userId));
}

export const realtime = {
  toUser<E extends keyof RealtimeEvents>(userId: string, event: E, payload: RealtimeEvents[E]) {
    io?.to(userRoom(userId)).emit(event, payload);
  },
  toAppointment<E extends keyof RealtimeEvents>(appointmentId: string, event: E, payload: RealtimeEvents[E]) {
    io?.to(appointmentRoom(appointmentId)).emit(event, payload);
  },
};

export async function closeRealtime() {
  await io?.close();
  io = null;
}
