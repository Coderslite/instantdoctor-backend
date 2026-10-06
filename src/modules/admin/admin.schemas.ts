import { z } from 'zod';
import { APPOINTMENT_STATUSES, LAB_RESULT_STATUSES, ORDER_STATUSES, PAYMENT_STATUSES } from '../../db/schema/index.js';

export const adminLoginSchema = z.object({ email: z.email(), password: z.string().min(8).max(128) });
export const adminListQuery = z.object({
  search: z.string().trim().max(100).optional(),
  status: z.string().trim().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export const userStatusSchema = z.object({ status: z.enum(['active', 'suspended']) });
export const appointmentStatusSchema = z.object({ status: z.enum(APPOINTMENT_STATUSES) });
export const updateAppointmentSchema = z.object({
  doctorId: z.string().min(1).nullable().optional(), status: z.enum(APPOINTMENT_STATUSES).optional(), complaint: z.string().trim().max(5000).nullable().optional(),
  packageLabel: z.string().trim().min(1).max(128).optional(), startTime: z.coerce.date().optional(), endTime: z.coerce.date().optional(),
  price: z.coerce.number().nonnegative().optional(), currency: z.string().trim().length(3).toUpperCase().nullable().optional(), isPaid: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required');
export const createAppointmentSchema = z.object({
  patientId: z.string().min(1), doctorId: z.string().min(1).nullable().optional(), complaint: z.string().trim().max(5000).nullable().optional(),
  symptoms: z.array(z.string().trim().min(1).max(100)).max(30).default([]), status: z.enum(APPOINTMENT_STATUSES).default('pending'),
  packageLabel: z.string().trim().min(1).max(128), packageType: z.enum(['basic', 'standard', 'special']).nullable().optional(),
  startTime: z.coerce.date(), endTime: z.coerce.date(), timeZone: z.string().trim().max(64).nullable().optional(),
  price: z.coerce.number().nonnegative(), currency: z.string().trim().length(3).toUpperCase(), isTrial: z.boolean().default(false), isPaid: z.boolean().default(false),
});
export const appointmentPackageSchema = z.object({
  name: z.string().trim().min(1).max(128), type: z.enum(['basic', 'standard', 'special']), amountUsd: z.coerce.number().positive(),
  listAmountUsd: z.coerce.number().positive().nullable().optional(), durationMinutes: z.coerce.number().int().min(5).max(1440),
  description: z.string().trim().max(5000).nullable().optional(), isActive: z.boolean().default(true),
});
export const updateAppointmentPackageSchema = appointmentPackageSchema.partial().refine((value) => Object.keys(value).length > 0, 'At least one field is required');
export const pharmacySchema = z.object({ name: z.string().trim().min(1).max(255), email: z.email(), password: z.string().min(8).max(128), phoneNumber: z.string().trim().max(32).nullable().optional(), address: z.string().trim().max(512).nullable().optional(), latitude: z.coerce.number().min(-90).max(90).nullable().optional(), longitude: z.coerce.number().min(-180).max(180).nullable().optional(), deliveryFeePerKm: z.coerce.number().nonnegative().default(0), discount: z.coerce.number().int().min(0).max(100).default(0), image: z.url().max(1024).nullable().optional(), status: z.string().trim().min(1).max(32).default('active') });
export const updatePharmacySchema = pharmacySchema.partial().refine((value) => Object.keys(value).length > 0, 'At least one field is required');
export const productSchema = z.object({ pharmacyId: z.string().min(1), categoryId: z.string().min(1).nullable().optional(), name: z.string().trim().min(1).max(255), description: z.string().trim().max(5000).nullable().optional(), amount: z.coerce.number().nonnegative(), purchasePrice: z.coerce.number().nonnegative().nullable().optional(), discount: z.coerce.number().int().min(0).max(100).default(0), stockRemaining: z.coerce.number().int().nonnegative().default(0), images: z.array(z.url().max(1024)).max(12).default([]), status: z.string().trim().min(1).max(32).default('active') });
export const updateProductSchema = productSchema.omit({ pharmacyId: true }).partial().refine((value) => Object.keys(value).length > 0, 'At least one field is required');
export const importProductsSchema = z.object({ products: z.array(productSchema.omit({ pharmacyId: true }).extend({ id: z.string().optional() })).min(1).max(500) });
export const productCategorySchema = z.object({ name: z.string().trim().min(1).max(128) });
export const orderStatusSchema = z.object({ status: z.enum(ORDER_STATUSES) });
const optionalDate = z.preprocess((value) => value === '' ? null : value, z.coerce.date().nullable().optional());
export const labResultStatusSchema = z.object({
  status: z.enum(LAB_RESULT_STATUSES).optional(), resultUrl: z.url().max(1024).optional(), testName: z.string().trim().max(255).nullable().optional(),
  laboratoryName: z.string().trim().max(255).nullable().optional(), referenceNumber: z.string().trim().max(128).nullable().optional(),
  sampleCollectedAt: optionalDate, resultDate: optionalDate, interpretation: z.string().trim().max(20_000).nullable().optional(),
  adminResponse: z.string().trim().max(20_000).nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required');
export const paymentStatusSchema = z.object({ status: z.enum(PAYMENT_STATUSES), failureReason: z.string().max(512).nullable().optional() });
export const updatePatientSchema = z.object({
  firstName: z.string().trim().min(1).max(100).optional(), lastName: z.string().trim().min(1).max(100).optional(),
  email: z.email().optional(), phoneNumber: z.string().trim().max(32).nullable().optional(), gender: z.string().trim().max(32).nullable().optional(),
  dateOfBirth: z.coerce.date().nullable().optional(), maritalStatus: z.string().trim().max(32).nullable().optional(), country: z.string().trim().max(64).nullable().optional(),
  address: z.string().trim().max(512).nullable().optional(), currency: z.string().trim().length(3).toUpperCase().nullable().optional(),
  height: z.string().trim().max(16).nullable().optional(), weight: z.string().trim().max(16).nullable().optional(), bloodGroup: z.string().trim().max(8).nullable().optional(),
  genotype: z.string().trim().max(8).nullable().optional(), surgicalHistory: z.string().trim().max(5000).nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required');
export const updateDoctorSchema = z.object({
  firstName: z.string().trim().min(1).max(100).optional(), lastName: z.string().trim().min(1).max(100).optional(),
  email: z.email().optional(), phoneNumber: z.string().trim().max(32).nullable().optional(), gender: z.string().trim().max(32).nullable().optional(),
  country: z.string().trim().max(64).nullable().optional(), address: z.string().trim().max(512).nullable().optional(), currency: z.string().trim().length(3).toUpperCase().nullable().optional(),
  specialization: z.string().trim().max(128).nullable().optional(), experienceYears: z.coerce.number().int().min(0).max(80).nullable().optional(),
  bio: z.string().trim().max(5000).nullable().optional(), isAvailable: z.boolean().optional(), institution: z.string().trim().max(255).nullable().optional(),
  graduationYear: z.string().trim().max(8).nullable().optional(), housemanship: z.string().trim().max(255).nullable().optional(), housemanshipYear: z.string().trim().max(8).nullable().optional(),
  workAddress: z.string().trim().max(512).nullable().optional(), homeAddress: z.string().trim().max(512).nullable().optional(), certificateUrl: z.url().max(1024).nullable().optional(), certificateFileId: z.string().min(1).max(36).optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required');
export const patientEmailSchema = z.object({ subject: z.string().trim().min(1).max(200), message: z.string().trim().min(1).max(10_000) });
export const patientPushSchema = z.object({ title: z.string().trim().min(1).max(120), message: z.string().trim().min(1).max(500) });
