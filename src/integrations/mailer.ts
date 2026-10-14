import { eq } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { users } from '../db/schema/index.js';
import { logger } from '../lib/logger.js';
import { deliver } from './mail/transport.js';
import * as templates from './mail/templates.js';
import type { CodePurpose, OrderLine, RenderedMail } from './mail/templates.js';

const send = (to: string, category: string, mail: RenderedMail) => deliver({ to, category, ...mail });

export const mailer = {
  verificationCode: (input: {
    to: string;
    code: string;
    purpose: CodePurpose;
    firstName?: string | null;
    expiresInMinutes: number;
  }) => send(input.to, `code-${input.purpose}`, templates.verificationCode(input)),

  welcome: (input: { to: string; firstName?: string | null }) => send(input.to, 'welcome', templates.welcome(input)),

  signInAlert: (input: { to: string; firstName?: string | null; device: string; ipAddress?: string | null; at?: Date }) =>
    send(input.to, 'sign-in', templates.signInAlert({ ...input, at: input.at ?? new Date() })),

  passwordChanged: (input: { to: string; firstName?: string | null; at?: Date }) =>
    send(input.to, 'password-changed', templates.passwordChanged({ ...input, at: input.at ?? new Date() })),

  pharmacyNewOrder: (input: {
    to: string;
    pharmacyName?: string | null;
    trackingId: string;
    customerName: string;
    items: OrderLine[];
    deliveryAddress?: string | null;
  }) => send(input.to, 'pharmacy-order', templates.pharmacyNewOrder(input)),

  orderStatusUpdate: (input: { to: string } & Parameters<typeof templates.orderStatusUpdate>[0]) =>
    send(input.to, 'order-status', templates.orderStatusUpdate(input)),

  orderReceipt: (input: { to: string } & Parameters<typeof templates.orderReceipt>[0]) =>
    send(input.to, 'order-receipt', templates.orderReceipt(input)),

  pharmacyOrderIssue: (input: { to: string } & Parameters<typeof templates.pharmacyOrderIssue>[0]) =>
    send(input.to, 'pharmacy-issue', templates.pharmacyOrderIssue(input)),

  pharmacyNewReview: (input: { to: string } & Parameters<typeof templates.pharmacyNewReview>[0]) =>
    send(input.to, 'pharmacy-review', templates.pharmacyNewReview(input)),

  pharmacyPayoutUpdate: (input: { to: string } & Parameters<typeof templates.pharmacyPayoutUpdate>[0]) =>
    send(input.to, `pharmacy-payout-${input.event}`, templates.pharmacyPayoutUpdate(input)),

  pharmacyBankAccountChanged: (input: { to: string } & Parameters<typeof templates.pharmacyBankAccountChanged>[0]) =>
    send(input.to, 'pharmacy-bank-account', templates.pharmacyBankAccountChanged(input)),

  opsPayoutRequested: (input: Parameters<typeof templates.opsPayoutRequested>[0]) =>
    send(env.OPS_EMAIL, 'ops-payout', templates.opsPayoutRequested(input)),

  doctorPayoutUpdate: (input: { to: string } & Parameters<typeof templates.doctorPayoutUpdate>[0]) =>
    send(input.to, `doctor-payout-${input.event}`, templates.doctorPayoutUpdate(input)),

  doctorBankAccountChanged: (input: { to: string } & Parameters<typeof templates.doctorBankAccountChanged>[0]) =>
    send(input.to, 'doctor-bank-account', templates.doctorBankAccountChanged(input)),

  opsDoctorPayouts: (input: Parameters<typeof templates.opsDoctorPayouts>[0]) =>
    send(env.OPS_EMAIL, 'ops-doctor-payout', templates.opsDoctorPayouts(input)),

  opsAppointmentsReview: (input: Parameters<typeof templates.opsAppointmentsReview>[0]) =>
    send(env.OPS_EMAIL, 'ops-appointments-review', templates.opsAppointmentsReview(input)),

  appointmentUpdate: (input: { to: string } & templates.AppointmentEmailInput) =>
    send(input.to, `appointment-${input.event}`, templates.appointmentUpdate(input)),

  doctorApplicationReceived: (input: { to: string; firstName: string; reference: string }) =>
    send(input.to, 'doctor-application-received', templates.doctorApplicationReceived(input)),

  doctorApplicationApproved: (input: { to: string; firstName: string }) =>
    send(input.to, 'doctor-application-approved', templates.doctorApplicationApproved({ ...input, email: input.to })),

  doctorApplicationRejected: (input: { to: string; firstName: string; reason?: string | null }) =>
    send(input.to, 'doctor-application-rejected', templates.doctorApplicationRejected(input)),

  hmoApplicationReceived: (input: { to: string } & Parameters<typeof templates.hmoApplicationReceived>[0]) =>
    send(input.to, 'hmo-application-received', templates.hmoApplicationReceived(input)),

  hmoApplicationApproved: (input: { to: string } & Parameters<typeof templates.hmoApplicationApproved>[0]) =>
    send(input.to, 'hmo-application-approved', templates.hmoApplicationApproved(input)),

  hmoApplicationRejected: (input: { to: string } & Parameters<typeof templates.hmoApplicationRejected>[0]) =>
    send(input.to, 'hmo-application-rejected', templates.hmoApplicationRejected(input)),

  hmoAuthorizationRequested: (input: { to: string } & Parameters<typeof templates.hmoAuthorizationRequested>[0]) =>
    send(input.to, 'hmo-authorization-requested', templates.hmoAuthorizationRequested(input)),

  opsHmoApplication: (input: Parameters<typeof templates.opsHmoApplication>[0]) =>
    send(env.OPS_EMAIL, 'ops-hmo-application', templates.opsHmoApplication(input)),

  opsDoctorApplication: (input: Parameters<typeof templates.opsDoctorApplication>[0]) =>
    send(env.OPS_EMAIL, 'ops-doctor-application', templates.opsDoctorApplication(input)),

  async activity(userId: string, activity: string) {
    try {
      const [user] = await db
        .select({
          id: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
          phoneNumber: users.phoneNumber,
          country: users.country,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!user) return;
      await send(
        env.OPS_EMAIL,
        'ops-activity',
        templates.opsActivity({
          activity,
          user: { ...user, name: `${user.firstName} ${user.lastName}`.trim() },
          at: new Date(),
        }),
      );
    } catch (err) {
      logger.error({ err, userId, activity }, 'Failed to send activity email');
    }
  },
};
