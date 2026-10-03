// Runs before each test file (and before any app module reads the environment).
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'mysql://root:root@127.0.0.1:8889/instant_doctor_test';
process.env.JWT_ACCESS_SECRET ??= 'test-secret-test-secret-test-secret-test-secret';
process.env.ENABLE_PUSH = 'false';
process.env.MAIL_SERVICE_URL = '';
process.env.FIREBASE_WEB_API_KEY = '';
process.env.BOOKING_MIN_LEAD_MINUTES = '5';
process.env.BOOKING_HOLD_MINUTES = '30';
