/**
 * Lets browsers (the admin and pharmacy portals) upload straight to R2 with
 * presigned URLs. Mobile apps don't need CORS. Run once per environment:
 *   UPLOAD_CORS_ORIGINS=https://admin.instantdoctor.co,https://pharmacy.instantdoctor.co npm run storage:cors
 * Falls back to CORS_ORIGINS when UPLOAD_CORS_ORIGINS is unset.
 */
import { PutBucketCorsCommand, S3Client } from '@aws-sdk/client-s3';
import { env } from '../src/config/env.js';

if (env.STORAGE_DRIVER !== 'r2') throw new Error('STORAGE_DRIVER must be r2');
const origins = (process.env.UPLOAD_CORS_ORIGINS ?? env.CORS_ORIGINS)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
if (!origins.length) throw new Error('Set UPLOAD_CORS_ORIGINS (comma-separated origins)');

const client = new S3Client({
  region: 'auto',
  endpoint: env.R2_ENDPOINT ?? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: env.R2_ACCESS_KEY_ID!, secretAccessKey: env.R2_SECRET_ACCESS_KEY! },
  forcePathStyle: true,
});
const buckets = [
  ...new Set([env.R2_PUBLIC_BUCKET ?? env.R2_BUCKET, env.R2_PRIVATE_BUCKET].filter(Boolean)),
] as string[];

let failed = false;
for (const bucket of buckets) {
  try {
    await client.send(
      new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: origins,
              AllowedMethods: ['PUT'],
              AllowedHeaders: ['content-type'],
              MaxAgeSeconds: 3600,
            },
            {
              AllowedOrigins: origins,
              AllowedMethods: ['GET', 'HEAD'],
              AllowedHeaders: ['*'],
              MaxAgeSeconds: 3600,
            },
          ],
        },
      }),
    );
    console.log(`CORS set on ${bucket} for ${origins.join(', ')}`);
  } catch (err) {
    failed = true;
    console.error(
      `Could not set CORS on ${bucket}: ${(err as Error).name} — ${(err as Error).message}`,
    );
  }
}
if (failed) process.exitCode = 1;
