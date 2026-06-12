/**
 * r2.ts — R2 is a workbench, not a database (PRD §3.4, §5).
 * Only three prefixes may ever exist: pdf/, work/, review/.
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { CFG } from './config';
import { withRetry } from './util/retry';

const ALLOWED_PREFIXES = ['pdf/', 'work/', 'review/'] as const;

function assertKey(key: string): void {
  if (!ALLOWED_PREFIXES.some((p) => key.startsWith(p))) {
    throw new Error(`[r2] refusing key outside the three allowed prefixes: ${key}`);
  }
}

function client(): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: CFG.r2.endpoint,
    credentials: { accessKeyId: CFG.r2.accessKeyId, secretAccessKey: CFG.r2.secretAccessKey },
  });
}

export interface R2 {
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<Array<{ key: string; size: number }>>;
  presign(key: string, expiresSeconds?: number): Promise<string>;
}

export function createR2(s3: S3Client = client()): R2 {
  return {
    async put(key, body, contentType) {
      assertKey(key);
      await withRetry(
        () => s3.send(new PutObjectCommand({ Bucket: CFG.r2.bucket, Key: key, Body: body, ContentType: contentType })),
        `r2-put-${key}`,
      );
    },

    async get(key) {
      assertKey(key);
      try {
        const res = await withRetry(
          () => s3.send(new GetObjectCommand({ Bucket: CFG.r2.bucket, Key: key })),
          `r2-get-${key}`,
        );
        const bytes = await res.Body?.transformToByteArray();
        return bytes ? Buffer.from(bytes) : null;
      } catch (e) {
        if (String(e).includes('NoSuchKey') || String(e).includes('404')) return null;
        throw e;
      }
    },

    async delete(key) {
      assertKey(key);
      await withRetry(
        () => s3.send(new DeleteObjectCommand({ Bucket: CFG.r2.bucket, Key: key })),
        `r2-del-${key}`,
      );
    },

    async list(prefix) {
      const out: Array<{ key: string; size: number }> = [];
      let token: string | undefined;
      do {
        const res = await withRetry(
          () => s3.send(new ListObjectsV2Command({ Bucket: CFG.r2.bucket, Prefix: prefix, ContinuationToken: token })),
          `r2-list-${prefix}`,
        );
        for (const o of res.Contents ?? []) {
          if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0 });
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
      return out;
    },

    async presign(key, expiresSeconds = 15 * 60) {
      assertKey(key);
      return getSignedUrl(s3, new GetObjectCommand({ Bucket: CFG.r2.bucket, Key: key }), {
        expiresIn: expiresSeconds,
      });
    },
  };
}
