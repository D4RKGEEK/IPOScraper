'use strict';

/**
 * cache.js — Response caching for LLM and Firecrawl API calls.
 *
 * Uses MongoDB in production (persists across deploys, works across instances).
 * Falls back to disk-based caching in development for convenience.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { env } = require('./config');
const { logger } = require('../utils/logger');

const log = logger.child({ module: 'extraction:cache' });

/**
 * Generate a deterministic cache key from a namespace and identifier string.
 * @param {string} namespace  e.g. 'llm_toc', 'firecrawl', 'gemini'
 * @param {string} identifier  e.g. prompt text, section + slug combo
 * @returns {string} namespaced hash key
 */
function generateCacheKey(namespace, identifier) {
  const hash = crypto.createHash('sha256').update(identifier).digest('hex').slice(0, 24);
  return `${namespace}/${hash}`;
}

// ── MongoDB-backed cache (production) ────────────────────────────────────────

let _cacheCollection = null;

function getCacheCollection() {
  if (!_cacheCollection) {
    const { collections } = require('../db/mongo');
    _cacheCollection = collections.extractionCache();
  }
  return _cacheCollection;
}

async function getMongoCache(key) {
  try {
    const doc = await getCacheCollection().findOne({ key });
    if (doc) {
      log.debug({ key }, 'cache hit (mongo)');
      return doc.data;
    }
    return null;
  } catch {
    return null;
  }
}

async function setMongoCache(key, data) {
  try {
    await getCacheCollection().updateOne(
      { key },
      { $set: { key, data, updatedAt: new Date().toISOString() } },
      { upsert: true },
    );
    log.debug({ key }, 'cache set (mongo)');
  } catch (e) {
    log.warn({ key, err: e.message }, 'mongo cache write failed');
  }
}

// ── Disk-backed cache (development) ──────────────────────────────────────────

function getDiskCache(key) {
  const filePath = path.join(env.CACHE_DIR, `${key}.json`);
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    log.debug({ key }, 'cache hit (disk)');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function setDiskCache(key, data) {
  const filePath = path.join(env.CACHE_DIR, `${key}.json`);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    log.debug({ key }, 'cache set (disk)');
  } catch (e) {
    log.warn({ key, err: e.message }, 'disk cache write failed');
  }
}

// ── Public API (auto-selects backend) ────────────────────────────────────────

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Get a cached response by key.
 * Uses MongoDB in production, disk in development.
 * @param {string} key  e.g. 'llm_toc/abc123'
 * @returns {object|null|Promise<object|null>}
 */
function getCachedResponse(key) {
  return isProduction ? getMongoCache(key) : getDiskCache(key);
}

/**
 * Store a response in the cache.
 * @param {string} key   e.g. 'llm_toc/abc123'
 * @param {object} data  JSON-serializable data
 */
function setCachedResponse(key, data) {
  return isProduction ? setMongoCache(key, data) : setDiskCache(key, data);
}

module.exports = { generateCacheKey, getCachedResponse, setCachedResponse };
