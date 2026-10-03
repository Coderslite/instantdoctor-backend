import { Router } from 'express';
import { anonymousRouter } from './modules/anonymous/anonymous.routes.js';
import { appointmentsRouter } from './modules/appointments/appointments.routes.js';
import { prescriptionsRouter } from './modules/appointments/prescriptions.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { doctorsRouter } from './modules/doctors/doctors.routes.js';
import { healthTipsRouter } from './modules/health-tips/health-tips.routes.js';
import { labResultsRouter } from './modules/lab-results/lab-results.routes.js';
import { medicationsRouter } from './modules/medications/medications.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { paymentsRouter } from './modules/payments/payments.routes.js';
import { pharmacyRouter } from './modules/pharmacy/pharmacy.routes.js';
import { referralsRouter } from './modules/referrals/referrals.routes.js';
import { reportsRouter } from './modules/reports/reports.routes.js';
import { settingsRouter } from './modules/settings/settings.routes.js';
import { uploadsRouter } from './modules/uploads/uploads.routes.js';
import { usersRouter } from './modules/users/users.routes.js';
import { waitlistRouter } from './modules/waitlist/waitlist.routes.js';
import { walletRouter } from './modules/wallet/wallet.routes.js';

export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/doctors', doctorsRouter);
apiRouter.use('/appointments', appointmentsRouter);
apiRouter.use('/prescriptions', prescriptionsRouter);
apiRouter.use('/payments', paymentsRouter);
apiRouter.use('/wallet', walletRouter);
apiRouter.use('/referrals', referralsRouter);
apiRouter.use('/lab-results', labResultsRouter);
apiRouter.use('/medications', medicationsRouter);
apiRouter.use('/health-tips', healthTipsRouter);
apiRouter.use('/notifications', notificationsRouter);
apiRouter.use('/anonymous-questions', anonymousRouter);
apiRouter.use('/reports', reportsRouter);
apiRouter.use('/waitlist', waitlistRouter);
apiRouter.use('/uploads', uploadsRouter);
apiRouter.use('/', settingsRouter); // /settings, /currencies, /video-call
apiRouter.use('/', pharmacyRouter); // /pharmacies, /products, /orders
