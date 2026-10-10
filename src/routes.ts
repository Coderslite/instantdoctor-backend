import { Router } from 'express';
import { anonymousRouter } from './modules/anonymous/anonymous.routes.js';
import { appointmentsRouter } from './modules/appointments/appointments.routes.js';
import { prescriptionsRouter } from './modules/appointments/prescriptions.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { doctorsRouter } from './modules/doctors/doctors.routes.js';
import {
  adminDoctorApplicationsRouter,
  doctorApplicationsRouter,
} from './modules/doctor-applications/doctor-applications.routes.js';
import { mailCenterRouter } from './modules/mail-center/mail-center.routes.js';
import { adminBlogRouter, blogRouter } from './modules/blog/blog.routes.js';
import { healthTipsRouter } from './modules/health-tips/health-tips.routes.js';
import { labResultsRouter } from './modules/lab-results/lab-results.routes.js';
import { medicationsRouter } from './modules/medications/medications.routes.js';
import { carePlansRouter } from './modules/care-plans/care-plans.routes.js';
import {
  careSummaryRouter,
  publicCareSummaryRouter,
} from './modules/family/care-summary.routes.js';
import { familyRouter } from './modules/family/family.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { paymentsRouter } from './modules/payments/payments.routes.js';
import { pharmacyRouter } from './modules/pharmacy/pharmacy.routes.js';
import { referralsRouter } from './modules/referrals/referrals.routes.js';
import { reportsRouter } from './modules/reports/reports.routes.js';
import { settingsRouter } from './modules/settings/settings.routes.js';
import { filesRouter, uploadsRouter } from './modules/files/files.routes.js';
import { usersRouter } from './modules/users/users.routes.js';
import { waitlistRouter } from './modules/waitlist/waitlist.routes.js';
import { walletRouter } from './modules/wallet/wallet.routes.js';
import { adminRouter } from './modules/admin/admin.routes.js';
import { pharmacyPortalRouter } from './modules/pharmacy-portal/pharmacy-portal.routes.js';
import { subscriptionsRouter } from './modules/subscriptions/subscriptions.routes.js';

export const apiRouter = Router();

apiRouter.use('/admin/blog', adminBlogRouter);
apiRouter.use('/admin/mail', mailCenterRouter);
apiRouter.use('/admin/doctor-applications', adminDoctorApplicationsRouter);
apiRouter.use('/admin', adminRouter);
apiRouter.use('/pharmacy-portal', pharmacyPortalRouter);
apiRouter.use('/auth', authRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/doctors', doctorsRouter);
apiRouter.use('/doctor-applications', doctorApplicationsRouter);
apiRouter.use('/appointments', appointmentsRouter);
apiRouter.use('/prescriptions', prescriptionsRouter);
apiRouter.use('/payments', paymentsRouter);
apiRouter.use('/subscriptions', subscriptionsRouter);
apiRouter.use('/wallet', walletRouter);
apiRouter.use('/referrals', referralsRouter);
apiRouter.use('/lab-results', labResultsRouter);
apiRouter.use('/medications', medicationsRouter);
apiRouter.use('/care-plans', carePlansRouter);
apiRouter.use('/family-profiles', familyRouter);
apiRouter.use('/care-summary', careSummaryRouter);
apiRouter.use('/care-summaries', publicCareSummaryRouter);
apiRouter.use('/health-tips', healthTipsRouter);
apiRouter.use('/blog', blogRouter);
apiRouter.use('/notifications', notificationsRouter);
apiRouter.use('/anonymous-questions', anonymousRouter);
apiRouter.use('/reports', reportsRouter);
apiRouter.use('/waitlist', waitlistRouter);
apiRouter.use('/uploads', uploadsRouter);
apiRouter.use('/files', filesRouter);
apiRouter.use('/', settingsRouter); // /settings, /currencies, /video-call
apiRouter.use('/', pharmacyRouter); // /pharmacies, /products, /orders
