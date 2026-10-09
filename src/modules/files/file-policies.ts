import type { FileVisibility } from '../../db/schema/files.js';

export type UploaderKind = 'patient' | 'doctor' | 'admin' | 'pharmacy' | 'applicant';

const WEB_IMAGES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const PHOTOS = [...WEB_IMAGES, 'image/heic', 'image/heif'];
const PDF = ['application/pdf'];
const WORD = [
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];
const AUDIO = [
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/m4a',
  'audio/x-m4a',
  'audio/wav',
  'audio/ogg',
  'audio/webm',
];
const MB = 1024 * 1024;

export interface FilePolicy {
  visibility: FileVisibility;
  contentTypes: readonly string[];
  maxBytes: number;
  uploaders: readonly UploaderKind[];
  description: string;
}

export const FILE_POLICIES = {
  avatar: {
    visibility: 'public',
    contentTypes: PHOTOS,
    maxBytes: 5 * MB,
    uploaders: ['patient', 'doctor'],
    description: 'Profile photo',
  },
  chat_attachment: {
    visibility: 'private',
    contentTypes: [...PHOTOS, ...PDF, ...WORD, ...AUDIO],
    maxBytes: 20 * MB,
    uploaders: ['patient', 'doctor'],
    description: 'Image, document or voice note sent in a consultation chat',
  },
  lab_result: {
    visibility: 'private',
    contentTypes: [...PHOTOS, ...PDF],
    maxBytes: 15 * MB,
    uploaders: ['patient'],
    description: 'Lab result submitted for interpretation',
  },
  report_attachment: {
    visibility: 'private',
    contentTypes: [...PHOTOS, ...PDF],
    maxBytes: 15 * MB,
    uploaders: ['patient'],
    description: 'Evidence attached to an appointment report',
  },
  doctor_document: {
    visibility: 'private',
    contentTypes: [...PHOTOS, ...PDF],
    maxBytes: 10 * MB,
    uploaders: ['doctor', 'admin', 'applicant'],
    description: 'Licence, certificate or ID for doctor verification',
  },
  lab_result_report: {
    visibility: 'private',
    contentTypes: [...PHOTOS, ...PDF],
    maxBytes: 15 * MB,
    uploaders: ['admin'],
    description: 'Interpreted lab result returned to the patient',
  },
  blog_image: {
    visibility: 'public',
    contentTypes: WEB_IMAGES,
    maxBytes: 8 * MB,
    uploaders: ['admin'],
    description: 'Featured or inline image for a blog post',
  },
  product_image: {
    visibility: 'public',
    contentTypes: WEB_IMAGES,
    maxBytes: 5 * MB,
    uploaders: ['pharmacy', 'admin'],
    description: 'Pharmacy product photo',
  },
  pharmacy_logo: {
    visibility: 'public',
    contentTypes: WEB_IMAGES,
    maxBytes: 5 * MB,
    uploaders: ['pharmacy', 'admin'],
    description: 'Pharmacy logo or storefront image',
  },
} as const satisfies Record<string, FilePolicy>;

export type FilePurpose = keyof typeof FILE_POLICIES;

export const FILE_PURPOSES = Object.keys(FILE_POLICIES) as [FilePurpose, ...FilePurpose[]];

export const MAX_UPLOAD_BYTES = Math.max(...Object.values(FILE_POLICIES).map((p) => p.maxBytes));

export const purposesFor = (kind: UploaderKind) =>
  FILE_PURPOSES.filter((purpose) =>
    (FILE_POLICIES[purpose].uploaders as readonly string[]).includes(kind),
  );
