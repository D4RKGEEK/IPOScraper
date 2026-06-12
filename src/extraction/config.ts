/**
 * config.ts — env validated by zod at boot (PRD §11.1, §16.1).
 * Nothing global except this config.
 */
import 'dotenv/config';
import { z } from 'zod';

const Env = z.object({
  MONGODB_URI: z.string().default('mongodb://localhost:27017'),
  // Separate DB keeps PRD collection names (documents/ipos/review_queue/events)
  // exact without clashing with the scraper's existing `ipos` collection.
  MONGODB_EXTRACTION_DB: z.string().default('ipo_extraction'),
  R2_ENDPOINT: z.string().min(1),            // https://<account>.r2.cloudflarestorage.com
  R2_BUCKET: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET: z.string().min(1),
  FIRECRAWL_API_KEY: z.string().min(1),
  DEEPSEEK_API_KEY: z.string().min(1),
  SERVICE_API_KEY: z.string().min(1),        // X-API-Key for our own REST API
  EXTRACTION_PORT: z.coerce.number().int().positive().default(8090),
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
  throw new Error(`[extraction/config] invalid or missing env: ${missing}`);
}
const env = parsed.data;

export const CFG = {
  mongoUrl: env.MONGODB_URI,
  mongoDb: env.MONGODB_EXTRACTION_DB,
  r2: {
    endpoint: env.R2_ENDPOINT,
    bucket: env.R2_BUCKET,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET,
  },
  firecrawl: { apiKey: env.FIRECRAWL_API_KEY, base: 'https://api.firecrawl.dev' },
  deepseek: { apiKey: env.DEEPSEEK_API_KEY, base: 'https://api.deepseek.com' },
  apiKey: env.SERVICE_API_KEY,
  port: env.EXTRACTION_PORT,
  budget: { wallMsPerDoc: 600_000, maxAttemptsPerField: 4 },
  keepOriginalPdf: false,
} as const;
