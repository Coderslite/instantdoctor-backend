import { z } from 'zod';

const location = {
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
};

export const joinWaitlistSchema = z.object({ address: z.string().trim().min(2).max(512), ...location });
export const waitlistStatusQuery = z.object(location);
