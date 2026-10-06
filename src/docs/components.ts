/**
 * Response models for the OpenAPI document. Request schemas are NOT redefined
 * here: the docs import the same Zod schemas the handlers validate with.
 * `.meta({ id })` registers a schema as a reusable component.
 */
import { z } from 'zod';
import {
  APPOINTMENT_STATUSES,
  LAB_RESULT_STATUSES,
  MESSAGE_STATUSES,
  MESSAGE_TYPES,
  NOTIFICATION_TYPES,
  ORDER_STATUSES,
  PACKAGE_TYPES,
  PAYMENT_METHODS,
  PAYMENT_PROVIDERS,
  PAYMENT_PURPOSES,
  PAYMENT_STATUSES,
  REPORT_STATUSES,
} from '../db/schema/index.js';

const id = z.string().meta({ example: 'E7lvcmYH7Ks38oEDCKm8' });
const dateTime = z.iso.datetime().meta({ example: '2026-10-01T11:00:00.000Z' });
const nullableDateTime = dateTime.nullable();
const money = z.number().meta({ example: 7500 });
const currency = z.string().length(3).meta({ example: 'NGN' });
const location = z.object({ latitude: z.number(), longitude: z.number() }).meta({ id: 'Location' });

export const ErrorResponse = z
  .object({
    error: z.object({
      code: z.string().meta({ example: 'SLOT_UNAVAILABLE' }),
      message: z.string().meta({ example: 'The doctor is already booked for this time' }),
      details: z.unknown().optional(),
    }),
  })
  .meta({
    id: 'Error',
    description: 'Every error response has this shape. `code` is stable and machine-readable.',
  });

export const page = <T extends z.ZodType>(item: T, name: string) =>
  z
    .object({
      items: z.array(item),
      limit: z.number().int().optional(),
      offset: z.number().int().optional(),
      nextOffset: z.number().int().nullable().optional(),
    })
    .meta({ id: `${name}Page` });

export const ItemsOf = <T extends z.ZodType>(item: T, name: string) =>
  z.object({ items: z.array(item) }).meta({ id: `${name}List` });

export const Count = z.object({ count: z.number().int() }).meta({ id: 'Count' });
export const Availability = z.object({ available: z.boolean() }).meta({ id: 'Availability' });

// ─── Users & auth ────────────────────────────────────────────────────────────

export const UserSummary = z
  .object({
    id,
    firstName: z.string(),
    lastName: z.string(),
    photoUrl: z.string().nullable(),
    role: z.enum(['user', 'doctor']),
    presence: z.string().meta({ example: 'online' }),
    lastSeenAt: nullableDateTime,
  })
  .meta({ id: 'UserSummary' });

export const Me = z
  .object({
    id,
    email: z.email(),
    role: z.enum(['user', 'doctor']),
    firstName: z.string(),
    lastName: z.string(),
    phoneNumber: z.string().nullable(),
    photoUrl: z.string().nullable(),
    gender: z.string().nullable(),
    dateOfBirth: nullableDateTime,
    maritalStatus: z.string().nullable(),
    stateOfOrigin: z.string().nullable(),
    otherLanguage: z.string().nullable(),
    country: z.string().nullable().meta({ example: 'NG' }),
    currency: currency.nullable(),
    address: z.string().nullable(),
    location: location.nullable(),
    tag: z.string().nullable().meta({ description: 'Referral username', example: 'ada2024' }),
    isTrialAvailable: z.boolean(),
    walletBalance: money,
    referral: z.object({
      balance: money,
      enabled: z.boolean(),
      programApplied: z.boolean(),
      programAppliedAt: nullableDateTime,
    }),
    medical: z
      .object({
        height: z.string().nullable(),
        weight: z.string().nullable(),
        bloodGroup: z.string().nullable(),
        genotype: z.string().nullable(),
        surgicalHistory: z.string().nullable(),
      })
      .nullable(),
    profileCompletion: z
      .object({
        complete: z.boolean(),
        missing: z.array(z.enum(['country', 'phoneNumber'])),
      })
      .meta({
        description:
          'Fields the user must provide before using the app. `phoneNumber` counts as missing when it is not a valid number for their country. Collect them with PATCH /users/me.',
      }),
    createdAt: dateTime,
  })
  .meta({ id: 'Me', description: 'The authenticated user’s own profile.' });

export const Session = z
  .object({
    accessToken: z
      .string()
      .meta({ description: 'JWT, short-lived (default 15 min). Send as `Authorization: Bearer`.' }),
    refreshToken: z
      .string()
      .meta({ description: 'Opaque, rotated on every refresh. Store securely.' }),
    tokenType: z.literal('Bearer'),
  })
  .meta({ id: 'Session' });

export const AuthResult = z
  .object({ user: Me, session: Session, isNewUser: z.boolean().optional() })
  .meta({ id: 'AuthResult' });

export const PendingRegistration = z
  .object({
    email: z.email(),
    status: z.literal('pending_verification'),
    codeExpiresInSeconds: z.number().int().meta({ example: 600 }),
  })
  .meta({
    id: 'PendingRegistration',
    description: 'Next: POST /auth/register/verify with the emailed code.',
  });

export const PasswordResetToken = z
  .object({
    resetToken: z.string().meta({ description: 'Single-use; send to POST /auth/password/reset.' }),
    expiresInSeconds: z.number().int().meta({ example: 900 }),
  })
  .meta({ id: 'PasswordResetToken' });

export const PayoutAccount = z
  .object({
    bankName: z.string().meta({ example: 'Access Bank' }),
    bankCode: z.string().nullable().meta({ example: '044' }),
    accountNumber: z.string().meta({ example: '0123456789' }),
    accountName: z.string().meta({ example: 'ADA OBI' }),
    updatedAt: dateTime,
  })
  .meta({
    id: 'PayoutAccount',
    description: 'Bank account that referral (and doctor) earnings are paid to.',
  });

export const MyReferral = z
  .object({
    referredBy: z
      .string()
      .nullable()
      .meta({ description: 'Referral code already applied, if any.', example: 'ada2024' }),
    canApplyCode: z.boolean(),
    applyBefore: dateTime.meta({
      description: 'End of the window for entering a code (7 days after sign-up).',
    }),
  })
  .meta({ id: 'MyReferral' });

export const SavedLocation = z
  .object({
    id,
    name: z.string(),
    address: z.string(),
    latitude: z.number(),
    longitude: z.number(),
  })
  .meta({ id: 'SavedLocation' });

export const Doctor = z
  .object({
    id,
    firstName: z.string(),
    lastName: z.string(),
    photoUrl: z.string().nullable(),
    gender: z.string().nullable(),
    presence: z.string(),
    lastSeenAt: nullableDateTime,
    specialization: z.string().nullable().meta({ example: 'Family Medicine' }),
    experienceYears: z.number().int().nullable(),
    bio: z.string().nullable(),
    isAvailable: z.boolean(),
    workingHours: z.array(z.unknown()),
    otherLanguage: z.string().nullable(),
    stateOfOrigin: z.string().nullable(),
    reviewCount: z.number().int(),
    averageRating: z.number().nullable().meta({ example: 4.5 }),
  })
  .meta({ id: 'Doctor' });

export const DoctorReview = z
  .object({
    id,
    rating: z.number().int().min(1).max(5),
    review: z.string().nullable(),
    appointmentId: id,
    createdAt: dateTime,
    reviewer: z.object({ id, firstName: z.string(), photoUrl: z.string().nullable() }),
  })
  .meta({ id: 'DoctorReview' });

// ─── Appointments ────────────────────────────────────────────────────────────

export const AppointmentPackage = z
  .object({
    id,
    name: z.string().meta({ example: 'Standard' }),
    type: z.enum(PACKAGE_TYPES),
    description: z.string().nullable(),
    durationSeconds: z.number().int().meta({ example: 3600 }),
    price: z.object({ amount: money, currency, amountUsd: z.number().meta({ example: 5 }) }),
  })
  .meta({
    id: 'AppointmentPackage',
    description: 'Priced for the caller’s region (discount + FX applied).',
  });

export const Appointment = z
  .object({
    id,
    status: z.enum(APPOINTMENT_STATUSES),
    complaint: z.string().nullable(),
    symptoms: z.array(z.string()).meta({ example: ['Fever', 'Headache'] }),
    package: z.object({
      id: id.nullable(),
      name: z.string(),
      type: z.enum(PACKAGE_TYPES).nullable(),
    }),
    startTime: dateTime,
    endTime: dateTime,
    price: money,
    currency: currency.nullable(),
    isTrial: z.boolean(),
    isPaid: z.boolean(),
    paidAt: nullableDateTime,
    doctor: UserSummary.nullable().meta({ description: 'Null while the request awaits a doctor.' }),
    patient: UserSummary,
    createdAt: dateTime,
    updatedAt: dateTime,
  })
  .meta({ id: 'Appointment' });

export const Message = z
  .object({
    id,
    appointmentId: id,
    senderId: id,
    receiverId: id,
    type: z.enum(MESSAGE_TYPES),
    status: z.enum(MESSAGE_STATUSES),
    message: z
      .string()
      .meta({ description: 'Opaque; the app currently sends client-encrypted text.' }),
    fileUrl: z.string().nullable(),
    repliedToId: id.nullable(),
    repliedText: z.string().nullable(),
    repliedSenderId: id.nullable(),
    isEdited: z.boolean(),
    editedAt: nullableDateTime,
    isDeleted: z.boolean(),
    deletedAt: nullableDateTime,
    createdAt: dateTime,
  })
  .meta({ id: 'Message' });

export const MessagePage = z
  .object({
    items: z.array(Message),
    nextBefore: nullableDateTime.meta({ description: 'Pass as `before` for the next page.' }),
  })
  .meta({ id: 'MessagePage' });

export const Prescription = z
  .object({
    id,
    appointmentId: id,
    userId: id,
    doctorId: id,
    prescription: z.string(),
    seen: z.boolean(),
    createdAt: dateTime,
  })
  .meta({ id: 'Prescription' });

export const Review = z
  .object({
    id,
    appointmentId: id,
    userId: id,
    doctorId: id,
    rating: z.number().int(),
    review: z.string().nullable(),
    createdAt: dateTime,
  })
  .meta({ id: 'Review' });

export const Report = z
  .object({
    id,
    appointmentId: id,
    userId: id,
    doctorId: id.nullable(),
    subject: z.string(),
    report: z.string(),
    status: z.enum(REPORT_STATUSES),
    createdAt: dateTime,
    updatedAt: dateTime,
  })
  .meta({ id: 'Report' });

export const ReportMessage = z
  .object({
    id,
    reportId: id,
    senderId: z.string().meta({ description: 'User id, or "admin" for support replies.' }),
    receiverId: z.string(),
    type: z.enum(MESSAGE_TYPES),
    status: z.enum(MESSAGE_STATUSES),
    message: z.string(),
    fileUrl: z.string().nullable(),
    createdAt: dateTime,
  })
  .meta({ id: 'ReportMessage' });

// ─── Payments & wallet ───────────────────────────────────────────────────────

export const ClientAction = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('stripe_payment_sheet'),
      clientSecret: z.string(),
      paymentIntentId: z.string(),
    }),
    z.object({
      type: z.literal('redirect'),
      authorizationUrl: z.url(),
      accessCode: z.string().optional().meta({ description: 'Paystack only.' }),
    }),
    z.object({
      type: z.literal('bank_transfer'),
      accountName: z.string().meta({ example: 'INSTANT DOCTOR CHECKOUT' }),
      accountNumber: z.string().meta({ example: '1260257501' }),
      bankName: z.string().meta({ example: 'Wema Bank' }),
      expiresAt: dateTime.meta({ description: 'The account stops accepting money at this time.' }),
      displayText: z.string().optional(),
    }),
  ])
  .meta({ id: 'ClientAction', description: 'What the app must do to let the customer pay.' });

export const Payment = z
  .object({
    id,
    reference: z.string().meta({ example: 'IDP_20261003_K7Q2M9XA4P' }),
    purpose: z.enum(PAYMENT_PURPOSES),
    purposeRefId: id.nullable(),
    provider: z.enum(PAYMENT_PROVIDERS),
    method: z.enum(PAYMENT_METHODS),
    status: z.enum(PAYMENT_STATUSES),
    baseAmount: money,
    surcharge: money,
    amount: money,
    currency,
    failureReason: z.string().nullable(),
    paidAt: nullableDateTime,
    bankTransfer: z
      .object({
        accountName: z.string(),
        accountNumber: z.string(),
        bankName: z.string(),
        expiresAt: dateTime,
        customerConfirmedAt: nullableDateTime,
      })
      .nullable()
      .meta({
        description: 'Account details for bank-transfer payments (to re-open the transfer screen).',
      }),
    createdAt: dateTime,
  })
  .meta({ id: 'Payment' });

export const PaymentInitialized = z
  .object({ payment: Payment, clientAction: ClientAction.nullable() })
  .meta({ id: 'PaymentInitialized' });

export const WebhookAck = z
  .object({ status: z.enum(['processed', 'duplicate']) })
  .meta({ id: 'WebhookAck' });

export const Wallet = z.object({ balance: money, currency }).meta({ id: 'Wallet' });

export const WalletTransaction = z
  .object({
    id,
    userId: id,
    type: z.enum(['credit', 'debit']),
    amount: money,
    currency,
    title: z.string(),
    balanceAfter: money.nullable(),
    paymentId: id.nullable(),
    createdAt: dateTime,
  })
  .meta({ id: 'WalletTransaction' });

export const TransferResult = z
  .object({ transaction: WalletTransaction.optional(), balance: money.nullable(), currency })
  .meta({ id: 'TransferResult' });

export const Referral = z
  .object({
    id,
    status: z.enum(['active', 'inactive']),
    totalCommissionEarned: money,
    createdAt: dateTime,
    referredUser: z.object({
      id,
      firstName: z.string(),
      lastName: z.string(),
      photoUrl: z.string().nullable(),
    }),
  })
  .meta({ id: 'Referral' });

export const ReferralSummary = z
  .object({
    tag: z.string().nullable(),
    referralCount: z.number().int(),
    totalEarned: money,
    balance: money,
  })
  .meta({ id: 'ReferralSummary' });

// ─── Pharmacy ────────────────────────────────────────────────────────────────

export const Pharmacy = z
  .object({
    id,
    name: z.string(),
    email: z.email(),
    phoneNumber: z.string().nullable(),
    address: z.string().nullable(),
    image: z.string().nullable(),
    discount: z.number().int(),
    deliveryFeePerKm: money,
    location: location.nullable(),
    distanceKm: z
      .number()
      .nullable()
      .meta({ description: 'Present when latitude/longitude were supplied.' }),
  })
  .meta({ id: 'Pharmacy' });

export const Product = z
  .object({
    id,
    pharmacyId: id,
    categoryId: id.nullable(),
    name: z.string(),
    description: z.string().nullable(),
    amount: money,
    purchasePrice: money.nullable(),
    discount: z.number().int(),
    stockRemaining: z.number().int(),
    images: z.array(z.string()),
    status: z.string(),
    createdAt: dateTime,
    updatedAt: dateTime,
  })
  .meta({ id: 'Product' });

export const ProductCategory = z.object({ id, name: z.string() }).meta({ id: 'ProductCategory' });

export const OrderItem = z
  .object({
    id,
    orderId: id,
    productId: id.nullable(),
    name: z.string(),
    unitPrice: money,
    discount: z.number().int(),
    quantity: z.number().int(),
    image: z.string().nullable(),
  })
  .meta({ id: 'OrderItem' });

export const Order = z
  .object({
    id,
    checkoutId: id.nullable(),
    userId: id,
    pharmacyId: id,
    trackingId: z.string().meta({ example: 'K7Q2M9XA' }),
    status: z.enum(ORDER_STATUSES),
    subtotal: money,
    deliveryFee: money,
    totalAmount: money,
    pharmacyEarning: money.nullable(),
    platformEarning: money.nullable(),
    address: z.string().nullable(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    items: z.array(OrderItem),
    createdAt: dateTime,
    updatedAt: dateTime,
  })
  .meta({ id: 'Order' });

export const CartQuote = z
  .object({
    currency,
    subtotal: money,
    deliveryFee: money,
    surcharge: money,
    totalAmount: money,
    amountDue: money.meta({ description: 'What the customer will be charged.' }),
    orders: z.array(
      z.object({
        pharmacyId: id,
        pharmacyName: z.string(),
        subtotal: money,
        deliveryFee: money,
        totalAmount: money,
      }),
    ),
  })
  .meta({ id: 'CartQuote' });

export const Checkout = z
  .object({
    id,
    userId: id,
    subtotal: money,
    deliveryFee: money,
    totalAmount: money,
    surcharge: money,
    amountDue: money,
    currency,
    status: z.enum(['awaiting_payment', 'paid', 'cancelled']),
    orders: z.array(Order),
    createdAt: dateTime,
    updatedAt: dateTime,
  })
  .meta({
    id: 'Checkout',
    description: 'Pay with POST /payments { purpose: "order_checkout", referenceId: id }.',
  });

// ─── Health ──────────────────────────────────────────────────────────────────

export const Quote = z
  .object({ amount: money, currency, amountUsd: z.number() })
  .meta({ id: 'Quote' });

export const LabResult = z
  .object({
    id,
    userId: id,
    status: z.enum(LAB_RESULT_STATUSES),
    price: money.nullable(),
    currency: currency.nullable(),
    resultUrl: z.string().nullable(),
    opened: z.boolean(),
    files: z.array(z.object({ fileUrl: z.string(), fileType: z.string() })),
    createdAt: dateTime,
    updatedAt: dateTime,
  })
  .meta({ id: 'LabResult' });

const clock = z.object({ hour: z.number().int(), minute: z.number().int() });

export const Medication = z
  .object({
    id,
    name: z.string(),
    prescription: z.string().nullable(),
    startTime: dateTime,
    endTime: dateTime,
    morningTime: z.string().nullable().meta({ example: '08:00' }),
    middayTime: z.string().nullable(),
    eveningTime: z.string().nullable(),
    intervalHours: z.number().int(),
    doses: z.array(
      z.object({
        date: z.iso.date(),
        time: z.string().nullable(),
        status: z.enum(['taken', 'missed']),
      }),
    ),
    takenDates: z.array(z.iso.date()),
    missedDates: z.array(z.iso.date()),
    dailyTakenTimes: z
      .record(z.string(), z.array(clock))
      .meta({ description: 'Keyed by YYYY-MM-DD (legacy app shape).' }),
    dailyMissedTimes: z.record(z.string(), z.array(clock)),
    createdAt: dateTime,
  })
  .meta({ id: 'Medication' });

// ─── Content & misc ──────────────────────────────────────────────────────────

export const HealthTipCategory = z
  .object({ id, name: z.string(), image: z.string().nullable(), articleCount: z.number().int() })
  .meta({ id: 'HealthTipCategory' });

export const HealthTipSummary = z
  .object({
    id,
    categoryId: id.nullable(),
    title: z.string(),
    slug: z.string().nullable(),
    image: z.string().nullable(),
    type: z.string(),
    views: z.number().int(),
    publishedAt: nullableDateTime,
  })
  .meta({ id: 'HealthTipSummary' });

export const HealthTip = HealthTipSummary.extend({
  description: z.string().meta({ description: 'HTML body.' }),
  isSent: z.boolean(),
  createdAt: dateTime,
  likeCount: z.number().int(),
  likedByMe: z.boolean(),
}).meta({ id: 'HealthTip' });

// ─── Blog ────────────────────────────────────────────────────────────────────

const BlogCategoryRef = z
  .object({ id, name: z.string(), slug: z.string().nullable() })
  .meta({ id: 'BlogCategoryRef' });
const BlogAuthorRef = z
  .object({
    id,
    name: z.string(),
    slug: z.string(),
    image: z.string().nullable(),
    jobTitle: z.string().nullable(),
  })
  .meta({ id: 'BlogAuthorRef' });

export const BlogAuthor = z
  .object({
    id,
    name: z.string(),
    slug: z.string(),
    jobTitle: z.string().nullable().meta({
      description: 'Credentials shown with the byline, e.g. "MBBS, General Practitioner".',
    }),
    bio: z.string().nullable(),
    image: z.string().nullable(),
    links: z
      .array(z.string())
      .meta({ description: 'Profile URLs, emitted as schema.org `sameAs`.' }),
  })
  .meta({ id: 'BlogAuthor' });

export const BlogPostSummary = z
  .object({
    id,
    slug: z.string().nullable(),
    title: z.string(),
    excerpt: z.string().nullable(),
    image: z.string().nullable(),
    imageAlt: z.string().nullable(),
    tags: z.array(z.string()),
    featured: z.boolean(),
    readingMinutes: z.number().int(),
    views: z.number().int(),
    publishedAt: nullableDateTime,
    updatedAt: dateTime,
    category: BlogCategoryRef.nullable(),
    author: BlogAuthorRef.nullable(),
  })
  .meta({ id: 'BlogPostSummary' });

export const BlogPostPage = z
  .object({
    items: z.array(BlogPostSummary),
    total: z.number().int(),
    page: z.number().int(),
    limit: z.number().int(),
    pages: z.number().int(),
  })
  .meta({ id: 'BlogPostPage' });

export const BlogPost = BlogPostSummary.extend({
  description: z.string().meta({ description: 'Sanitised HTML body.' }),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  focusKeyword: z.string().nullable(),
  canonicalUrl: z.string().nullable(),
  noindex: z.boolean(),
  reviewedAt: nullableDateTime,
  category: BlogCategoryRef.extend({ description: z.string().nullable() }).nullable(),
  author: BlogAuthor.nullable(),
  reviewer: BlogAuthor.nullable().meta({
    description: 'Clinician who medically reviewed the article.',
  }),
  related: z.array(BlogPostSummary),
  previous: BlogPostSummary.nullable(),
  next: BlogPostSummary.nullable(),
}).meta({ id: 'BlogPost' });

export const BlogCategory = z
  .object({
    id,
    name: z.string(),
    slug: z.string().nullable(),
    description: z.string().nullable(),
    image: z.string().nullable(),
    postCount: z.number().int(),
  })
  .meta({ id: 'BlogCategory' });

export const BlogCategoryDetail = z
  .object({
    id,
    name: z.string(),
    slug: z.string().nullable(),
    description: z.string().nullable(),
    image: z.string().nullable(),
    metaTitle: z.string().nullable(),
    metaDescription: z.string().nullable(),
    sortOrder: z.number().int(),
  })
  .meta({ id: 'BlogCategoryDetail' });

export const AdminBlogCategory = BlogCategoryDetail.extend({
  postCount: z.number().int(),
  liveCount: z.number().int(),
}).meta({ id: 'AdminBlogCategory' });
export const AdminBlogAuthor = BlogAuthor.extend({
  postCount: z.number().int(),
  reviewCount: z.number().int(),
}).meta({ id: 'AdminBlogAuthor' });
export const BlogTag = z
  .object({ name: z.string(), slug: z.string(), postCount: z.number().int() })
  .meta({ id: 'BlogTag' });

const SitemapEntry = z.object({
  slug: z.string().nullable(),
  postCount: z.number().int(),
  updatedAt: nullableDateTime,
});
export const BlogSitemap = z
  .object({
    posts: z.array(
      z.object({
        slug: z.string().nullable(),
        title: z.string(),
        excerpt: z.string().nullable(),
        image: z.string().nullable(),
        imageAlt: z.string().nullable(),
        tags: z.array(z.string()),
        categoryName: z.string().nullable(),
        authorName: z.string().nullable(),
        publishedAt: nullableDateTime,
        updatedAt: dateTime,
      }),
    ),
    categories: z.array(SitemapEntry),
    authors: z.array(SitemapEntry),
  })
  .meta({ id: 'BlogSitemap' });

export const AdminBlogPost = z
  .object({
    id,
    categoryId: id.nullable(),
    authorId: id.nullable(),
    reviewerId: id.nullable(),
    title: z.string(),
    slug: z.string().nullable(),
    excerpt: z.string().nullable(),
    description: z.string(),
    image: z.string().nullable(),
    imageAlt: z.string().nullable(),
    type: z.string(),
    status: z.enum(['draft', 'published']),
    featured: z.boolean(),
    tags: z.array(z.string()),
    readingMinutes: z.number().int(),
    metaTitle: z.string().nullable(),
    metaDescription: z.string().nullable(),
    focusKeyword: z.string().nullable(),
    canonicalUrl: z.string().nullable(),
    noindex: z.boolean(),
    views: z.number().int(),
    isSent: z.boolean(),
    publishedAt: nullableDateTime,
    reviewedAt: nullableDateTime,
    createdAt: dateTime,
    updatedAt: dateTime,
  })
  .meta({ id: 'AdminBlogPost' });

export const AdminBlogPostPage = z
  .object({
    items: z.array(
      BlogPostSummary.extend({
        status: z.enum(['draft', 'scheduled', 'published']),
        noindex: z.boolean(),
        focusKeyword: z.string().nullable(),
        createdAt: dateTime,
      }),
    ),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
    counts: z.object({
      all: z.number().int(),
      draft: z.number().int(),
      scheduled: z.number().int(),
      published: z.number().int(),
      views: z.number().int(),
    }),
  })
  .meta({ id: 'AdminBlogPostPage' });

export const Deleted = z.object({ deleted: z.literal(true) }).meta({ id: 'Deleted' });

export const LikeState = z.object({ liked: z.boolean() }).meta({ id: 'LikeState' });

export const Notification = z
  .object({
    id,
    userId: id,
    type: z.enum(NOTIFICATION_TYPES),
    title: z.string(),
    uniqueId: z.string().nullable(),
    status: z.enum(['delivered', 'read']),
    createdAt: dateTime,
  })
  .meta({ id: 'Notification' });

export const AnonymousQuestion = z
  .object({
    id,
    userId: id,
    question: z.string(),
    answer: z.string().nullable(),
    status: z.enum(['pending', 'completed']),
    createdAt: dateTime,
  })
  .meta({ id: 'AnonymousQuestion' });

export const WaitlistEntry = z
  .object({ id, userId: id, address: z.string(), latitude: z.number(), longitude: z.number() })
  .meta({ id: 'WaitlistEntry' });

export const StoredFile = z
  .object({
    id: z
      .string()
      .meta({
        description: 'Reference this as `fileId` (chat, reports, lab results, doctor documents).',
      }),
    purpose: z.string().meta({ example: 'chat_attachment' }),
    visibility: z.enum(['public', 'private']),
    url: z
      .url()
      .meta({
        description:
          'Public files: permanent. Private files: signed link valid until `urlExpiresAt`.',
      }),
    urlExpiresAt: nullableDateTime,
    contentType: z.string().meta({ example: 'image/jpeg' }),
    size: z.number().int(),
    name: z.string().nullable(),
    createdAt: dateTime,
  })
  .meta({ id: 'StoredFile' });

export const UploadSession = z
  .object({
    fileId: z
      .string()
      .meta({
        description: 'Confirm with `POST …/uploads/{fileId}/complete` once the PUT succeeds.',
      }),
    upload: z.object({
      method: z.literal('PUT'),
      url: z
        .url()
        .meta({
          description: 'Send the raw file bytes here (not multipart). Valid until `expiresAt`.',
        }),
      headers: z
        .record(z.string(), z.string())
        .meta({
          description: 'Send exactly these headers with the PUT.',
          example: { 'Content-Type': 'image/jpeg' },
        }),
      expiresAt: dateTime,
    }),
  })
  .meta({ id: 'UploadSession' });

export const AppSettings = z
  .object({
    trial: z.boolean(),
    anonymous: z.boolean(),
    inappNotice: z.boolean(),
    marquee: z.string(),
    showMarquee: z.boolean(),
    version: z.string(),
    versionCode: z.number().int().optional(),
    forceUpdate: z.boolean(),
    trialDoctor: z.string().optional(),
  })
  .loose()
  .meta({ id: 'AppSettings' });

export const VideoCallCredentials = z
  .object({
    provider: z.string().meta({ example: 'zegocloud' }),
    appId: z.number().int(),
    appSign: z.string(),
  })
  .meta({ id: 'VideoCallCredentials' });
