'use strict';

/**
 * mongo.js — MongoDB connection + collection accessors (native driver).
 *
 * Config (.env): MONGODB_URI (default mongodb://localhost:27017), MONGODB_DB (default "ipo").
 * Collections: ipos, gmp_history, jobs, extractions, extraction_cache.
 */

const { MongoClient } = require('mongodb');

const URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGODB_DB || 'ipo';

let client = null;
let db = null;

/** Connect (idempotent) and ensure indexes. Returns the Db. */
async function connect() {
  if (db) return db;
  client = new MongoClient(URI, { maxPoolSize: 10 });
  await client.connect();
  db = client.db(DB_NAME);
  await ensureIndexes(db);
  return db;
}

async function ensureIndexes(database) {
  const ipos = database.collection('ipos');
  await ipos.createIndex({ slug: 1 }, { unique: true });
  // Partial: only enforce uniqueness for real (string) ISINs; many records have null.
  await ipos.createIndex({ isin: 1 }, { unique: true, partialFilterExpression: { isin: { $type: 'string' } } });
  await ipos.createIndex({ symbol: 1 });
  await ipos.createIndex({ status: 1 });
  await ipos.createIndex({ listingDate: 1 });
  await ipos.createIndex({ companyName: 'text', symbol: 'text' });

  const gmp = database.collection('gmp_history');
  await gmp.createIndex({ slug: 1, date: -1 }, { unique: true, partialFilterExpression: { date: { $type: 'string' } } });

  const jobs = database.collection('jobs');
  await jobs.createIndex({ createdAt: -1 });
  await jobs.createIndex({ type: 1, status: 1 });

  const extractions = database.collection('extractions');
  await extractions.createIndex({ ipoSlug: 1, docType: 1, pipeline: 1 }, { unique: true });
  await extractions.createIndex({ status: 1 });

  const cache = database.collection('extraction_cache');
  await cache.createIndex({ key: 1 }, { unique: true });
  await cache.createIndex({ updatedAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 }); // auto-expire after 7 days
}

function getDb() {
  if (!db) throw new Error('Mongo not connected — call connect() first');
  return db;
}

const collections = {
  ipos: () => getDb().collection('ipos'),
  gmpHistory: () => getDb().collection('gmp_history'),
  jobs: () => getDb().collection('jobs'),
  extractions: () => getDb().collection('extractions'),
  extractionCache: () => getDb().collection('extraction_cache'),
  config: () => getDb().collection('config'),
};

async function close() {
  if (client) await client.close();
  client = null; db = null;
}

module.exports = { connect, getDb, collections, close, URI, DB_NAME };
