import { and, count, desc, eq, lt, ne, notInArray } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '../../db/client.js';
import { appointmentMessages, users } from '../../db/schema/index.js';
import { sendPush } from '../../integrations/push.js';
import { forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { realtime } from '../../realtime/gateway.js';
import { requireParticipant, touchAppointment } from './appointments.service.js';
import type { editMessageSchema, sendMessageSchema } from './appointments.schemas.js';

type MessageRow = typeof appointmentMessages.$inferSelect;

export async function listMessages(userId: string, appointmentId: string, query: { limit: number; before?: Date }) {
  await requireParticipant(appointmentId, userId);
  return db
    .select()
    .from(appointmentMessages)
    .where(
      and(
        eq(appointmentMessages.appointmentId, appointmentId),
        query.before ? lt(appointmentMessages.createdAt, query.before) : undefined,
      ),
    )
    .orderBy(desc(appointmentMessages.createdAt))
    .limit(query.limit);
}

export async function sendMessage(userId: string, appointmentId: string, input: z.infer<typeof sendMessageSchema>) {
  const appointment = await requireParticipant(appointmentId, userId);
  if (!appointment.isPaid) throw unprocessable('NOT_PAID', 'Chat opens once the appointment is paid');
  if (!appointment.doctorId) throw unprocessable('NOT_ASSIGNED', 'Chat opens once a doctor accepts the appointment');
  const receiverId = appointment.userId === userId ? appointment.doctorId : appointment.userId;

  const message: MessageRow = {
    id: newId(),
    appointmentId,
    senderId: userId,
    receiverId,
    type: input.type,
    status: 'delivered',
    message: input.message,
    fileUrl: input.fileUrl ?? null,
    repliedToId: input.repliedToId ?? null,
    repliedText: input.repliedText ?? null,
    repliedSenderId: input.repliedSenderId ?? null,
    isEdited: false,
    editedAt: null,
    isDeleted: false,
    deletedAt: null,
    createdAt: new Date(),
  };
  await db.insert(appointmentMessages).values(message);
  await touchAppointment(appointmentId);

  realtime.toAppointment(appointmentId, 'message:new', message);
  const [receiver] = await db.select({ token: users.fcmToken }).from(users).where(eq(users.id, receiverId));
  // Content may be client-encrypted, so the push carries a generic body.
  void sendPush([receiver?.token], {
    title: 'New message',
    body: input.type === 'text' ? 'You have a new message' : `You received a ${input.type}`,
    data: { id: appointmentId, type: 'chat' },
  });
  return message;
}

async function requireOwnMessage(userId: string, appointmentId: string, messageId: string) {
  await requireParticipant(appointmentId, userId);
  const [message] = await db
    .select()
    .from(appointmentMessages)
    .where(and(eq(appointmentMessages.id, messageId), eq(appointmentMessages.appointmentId, appointmentId)))
    .limit(1);
  if (!message) throw notFound('Message');
  if (message.senderId !== userId) throw forbidden('You can only change your own messages');
  if (message.isDeleted) throw unprocessable('MESSAGE_DELETED', 'This message has been deleted');
  return message;
}

export async function editMessage(
  userId: string,
  appointmentId: string,
  messageId: string,
  input: z.infer<typeof editMessageSchema>,
) {
  const message = await requireOwnMessage(userId, appointmentId, messageId);
  const patch = { message: input.message, isEdited: true, editedAt: new Date() };
  await db.update(appointmentMessages).set(patch).where(eq(appointmentMessages.id, messageId));
  const updated = { ...message, ...patch };
  realtime.toAppointment(appointmentId, 'message:updated', updated);
  return updated;
}

/** Soft delete: the row stays for thread continuity but its content is removed. */
export async function deleteMessage(userId: string, appointmentId: string, messageId: string) {
  const message = await requireOwnMessage(userId, appointmentId, messageId);
  const patch = { status: 'deleted' as const, isDeleted: true, deletedAt: new Date(), message: '', fileUrl: null };
  await db.update(appointmentMessages).set(patch).where(eq(appointmentMessages.id, messageId));
  realtime.toAppointment(appointmentId, 'message:updated', { ...message, ...patch });
}

const unreadFromOthers = (appointmentId: string, readerId: string) =>
  and(
    eq(appointmentMessages.appointmentId, appointmentId),
    ne(appointmentMessages.senderId, readerId),
    notInArray(appointmentMessages.status, ['read', 'deleted']),
  );

export async function markRead(userId: string, appointmentId: string) {
  await requireParticipant(appointmentId, userId);
  await db.update(appointmentMessages).set({ status: 'read' }).where(unreadFromOthers(appointmentId, userId));
  realtime.toAppointment(appointmentId, 'messages:read', { appointmentId, readerId: userId });
}

export async function unreadCount(userId: string, appointmentId: string) {
  await requireParticipant(appointmentId, userId);
  const [row] = await db.select({ n: count() }).from(appointmentMessages).where(unreadFromOthers(appointmentId, userId));
  return row?.n ?? 0;
}
