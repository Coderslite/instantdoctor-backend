import { z } from 'zod';

export const askQuestionSchema = z.object({ question: z.string().trim().min(5).max(5000) });
