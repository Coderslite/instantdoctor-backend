import type { doctorProfiles, userMedicalProfiles, users } from '../../db/schema/index.js';
import { isCountryCode, toE164 } from '../../lib/phone.js';

type User = typeof users.$inferSelect;
type Medical = typeof userMedicalProfiles.$inferSelect;
type Doctor = typeof doctorProfiles.$inferSelect;

/** The authenticated user's own profile. Never exposes credentials or tokens. */
export type ProfileRequirement = 'country' | 'phoneNumber';

export function missingProfileFields(user: Pick<User, 'country' | 'phoneNumber'>): ProfileRequirement[] {
  const missing: ProfileRequirement[] = [];
  if (!isCountryCode(user.country)) missing.push('country');
  if (!toE164(user.phoneNumber, user.country)) missing.push('phoneNumber');
  return missing;
}

export function serializeMe(user: User, medical?: Medical | null) {
  const missing = missingProfileFields(user);
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    firstName: user.firstName,
    lastName: user.lastName,
    phoneNumber: user.phoneNumber,
    photoUrl: user.photoUrl,
    gender: user.gender,
    dateOfBirth: user.dateOfBirth,
    maritalStatus: user.maritalStatus,
    stateOfOrigin: user.stateOfOrigin,
    otherLanguage: user.otherLanguage,
    country: user.country,
    currency: user.currency,
    address: user.address,
    location:
      user.latitude !== null && user.longitude !== null
        ? { latitude: user.latitude, longitude: user.longitude }
        : null,
    tag: user.tag,
    isTrialAvailable: user.isTrialAvailable,
    walletBalance: user.walletBalance,
    referral: {
      balance: user.referralBalance,
      enabled: user.referralEnabled,
      programApplied: user.referralProgramApplied,
      programAppliedAt: user.referralProgramAppliedAt,
    },
    medical: medical
      ? {
          height: medical.height,
          weight: medical.weight,
          bloodGroup: medical.bloodGroup,
          genotype: medical.genotype,
          surgicalHistory: medical.surgicalHistory,
        }
      : null,
    profileCompletion: { complete: missing.length === 0, missing },
    createdAt: user.createdAt,
  };
}

/** A doctor as seen by patients. */
export function serializeDoctor(user: User, profile: Doctor | null, stats?: { reviewCount: number; averageRating: number | null }) {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    photoUrl: user.photoUrl,
    gender: user.gender,
    presence: user.presence,
    lastSeenAt: user.lastSeenAt,
    specialization: profile?.specialization ?? null,
    experienceYears: profile?.experienceYears ?? null,
    bio: profile?.bio ?? null,
    isAvailable: profile?.isAvailable ?? false,
    workingHours: profile?.workingHours ?? [],
    otherLanguage: user.otherLanguage,
    stateOfOrigin: user.stateOfOrigin,
    reviewCount: stats?.reviewCount ?? 0,
    averageRating: stats?.averageRating ?? null,
  };
}

/** Minimal identity used in chat headers etc. */
export function serializeUserSummary(user: Pick<User, 'id' | 'firstName' | 'lastName' | 'photoUrl' | 'role' | 'presence' | 'lastSeenAt'>) {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    photoUrl: user.photoUrl,
    role: user.role,
    presence: user.presence,
    lastSeenAt: user.lastSeenAt,
  };
}
