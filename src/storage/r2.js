'use strict';

/**
 * r2.js — OPTIONAL Cloudflare R2 (S3-compatible) document store.
 *
 * Purpose: persist the converted markdown per IPO document so a re-extraction
 * (e.g. after tuning the schema/rules) can skip the expensive download +
 * PDF→markdown convert. Cloudflare R2 speaks the S3 API, so we use the AWS SDK
 * pointed at the account's R2 endpoint.
 *
 * Fully optional: if any of R2_ACCOUNT_ID / R2_ACCESS_KEY_ID /
 * R2_SECRET_ACCESS_KEY / R2_BUCKET is unset, isEnabled() is false and every
 * operation is a graceful no-op (getText → null, put/delete → resolve). The
 * extraction pipeline works either way; R2 only saves repeat work.
 *
 * Bucket stays MINIMAL: we only store markdown, and only for the CURRENT
 * document per IPO. Superseded docs and deleted IPOs are purged (see
 * ipoRepository.reconcileExtractions / deleteBySlug).
 *
 *   Key layout:  md/{ipoSlug}/{docType}.md
 */

const { logger } = require('../utils/logger');

const log = logger.child({ module: 'r2' });

const ENV = {
  accountId: process.env.R2_ACCOUNT_ID || '',
  accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  bucket: process.env.R2_BUCKET || '',
};

/** True only when every R2 setting is present. */
function isEnabled() {
  return !!(ENV.accountId && ENV.accessKeyId && ENV.secretAccessKey && ENV.bucket);
}

let _client = null;
let _S3 = null;

/** Lazily build the S3 client (require the SDK only when R2 is actually used). */
function client() {
  if (_client) return _client;
  // Lazy-require so deployments without R2 configured never load the SDK.
  _S3 = require('@aws-sdk/client-s3');
  _client = new _S3.S3Client({
    region: 'auto',
    endpoint: `https://${ENV.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: ENV.accessKeyId, secretAccessKey: ENV.secretAccessKey },
  });
  return _client;
}

/** Canonical markdown key for a document. */
function mdKey(slug, docType) {
  return `md/${slug}/${docType}.md`;
}

/** Stream/body → string. */
async function bodyToString(body) {
  if (!body) return '';
  if (typeof body.transformToString === 'function') return body.transformToString('utf-8');
  // Node stream fallback
  const chunks = [];
  for await (const c of body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString('utf-8');
}

/** Store UTF-8 text. No-op (resolves) when R2 is disabled. Returns the key or null. */
async function putText(key, text, contentType = 'text/markdown') {
  if (!isEnabled()) return null;
  await client().send(new _S3.PutObjectCommand({
    Bucket: ENV.bucket, Key: key, Body: text, ContentType: contentType,
  }));
  log.debug({ key, bytes: Buffer.byteLength(text) }, 'r2 put');
  return key;
}

/** Fetch UTF-8 text, or null if missing / R2 disabled. */
async function getText(key) {
  if (!isEnabled()) return null;
  try {
    const res = await client().send(new _S3.GetObjectCommand({ Bucket: ENV.bucket, Key: key }));
    return await bodyToString(res.Body);
  } catch (e) {
    if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
    log.warn({ key, err: e.message }, 'r2 get failed');
    return null;
  }
}

/** Delete a single key. No-op when disabled. Swallows missing-key errors. */
async function deleteKey(key) {
  if (!isEnabled()) return;
  try {
    await client().send(new _S3.DeleteObjectCommand({ Bucket: ENV.bucket, Key: key }));
    log.debug({ key }, 'r2 delete');
  } catch (e) {
    log.warn({ key, err: e.message }, 'r2 delete failed');
  }
}

/** Delete every object under a prefix (used to purge an IPO's documents). */
async function deletePrefix(prefix) {
  if (!isEnabled()) return;
  try {
    let token;
    do {
      const listed = await client().send(new _S3.ListObjectsV2Command({
        Bucket: ENV.bucket, Prefix: prefix, ContinuationToken: token,
      }));
      const objs = (listed.Contents || []).map((o) => ({ Key: o.Key }));
      if (objs.length) {
        await client().send(new _S3.DeleteObjectsCommand({
          Bucket: ENV.bucket, Delete: { Objects: objs, Quiet: true },
        }));
      }
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);
    log.debug({ prefix }, 'r2 delete prefix');
  } catch (e) {
    log.warn({ prefix, err: e.message }, 'r2 delete prefix failed');
  }
}

// ── Markdown convenience (keyed by slug + docType) ───────────────────────────

const putMarkdown = (slug, docType, text) => putText(mdKey(slug, docType), text);
const getMarkdown = (slug, docType) => getText(mdKey(slug, docType));
const deleteMarkdown = (slug, docType) => deleteKey(mdKey(slug, docType));
const deleteIpo = (slug) => deletePrefix(`md/${slug}/`);

module.exports = {
  isEnabled,
  mdKey,
  putText,
  getText,
  deleteKey,
  deletePrefix,
  putMarkdown,
  getMarkdown,
  deleteMarkdown,
  deleteIpo,
};
