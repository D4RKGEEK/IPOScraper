'use strict';

/**
 * ipoRepository.js — persistence + queries for IPO documents.
 *
 * Upsert key: ISIN when present, else symbol, else slug. Slug collisions across
 * different ISINs get a suffix. Merge preserves createdAt and deep-merges
 * documents/sources/raw_sources so no source's data is lost.
 */

const { collections } = require('./mongo');
const { toIpoDoc } = require('./ipoModel');
const { slugify } = require('../utils/slug');

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Find an existing doc that this record should merge into. */
async function findExisting(record) {
  const ipos = collections.ipos();
  if (record.isin) {
    const byIsin = await ipos.findOne({ isin: record.isin });
    if (byIsin) return byIsin;
  }
  if (record.symbol) {
    const bySym = await ipos.findOne({ symbol: record.symbol });
    if (bySym) return bySym;
  }
  // Fallback: same slug = same company. Catches cross-source records that lack a
  // shared ISIN/symbol (e.g. rumoured upcoming IPOs with no identifiers/dates),
  // which would otherwise collide on the unique slug index.
  if (record.companyName) {
    const bySlug = await ipos.findOne({ slug: slugify(record.companyName) });
    if (bySlug) return bySlug;
  }
  return null;
}

/** Resolve a unique slug, reusing existing.slug or suffixing on collision. */
async function resolveSlug(record, existing) {
  if (existing && existing.slug) return existing.slug;
  const ipos = collections.ipos();
  const base = slugify(record.companyName || record.symbol);
  const clash = await ipos.findOne({ slug: base });
  if (!clash) return base;
  // Different entity with same slug -> suffix with symbol/isin tail.
  return slugify(record.companyName || record.symbol, { suffix: record.symbol || (record.isin || '').slice(-4) });
}

/** Shallow-merge objects, preferring defined incoming values. */
function mergePreferIncoming(base = {}, incoming = {}) {
  const out = { ...base };
  for (const [k, v] of Object.entries(incoming)) {
    if (v !== null && v !== undefined && v !== '') out[k] = v;
  }
  return out;
}

/**
 * Deep-merge the documents map per docType. Incoming (from a scrape) only
 * carries {url, source}; this preserves processing fields written by the
 * document pipeline (status, markdownUrl, r2Url, pageHashes, sections) instead
 * of clobbering them on every re-scrape.
 */
function mergeDocuments(existing = {}, incoming = {}) {
  const out = { ...existing };
  for (const [type, inc] of Object.entries(incoming || {})) {
    out[type] = mergePreferIncoming(out[type] || {}, inc || {});
  }
  return out;
}

/**
 * Upsert one standardized record. Returns { action, slug, changes }.
 * action ∈ new | updated | unchanged.
 */
async function upsertRecord(record, opts = {}) {
  const ipos = collections.ipos();
  const now = opts.now || new Date().toISOString();
  const existing = await findExisting(record);
  const slug = await resolveSlug(record, existing);
  const incoming = toIpoDoc({ ...record, slug }, { now });

  if (!existing) {
    const doc = { ...incoming, createdAt: now };
    try {
      await ipos.insertOne(doc);
      return { action: 'new', slug, changes: [] };
    } catch (e) {
      if (e.code !== 11000) throw e;
      // Lost a race / slug already taken — fall through to merge into it.
      const clash = await ipos.findOne({ slug });
      if (!clash) throw e;
      return upsertInto(clash, incoming, now);
    }
  }

  return upsertInto(existing, incoming, now);
}

/** Merge incoming into an existing doc; returns {action, slug, changes}. */
async function upsertInto(existing, incoming, now) {
  const ipos = collections.ipos();

  // Merge: documents/sources/raw_sources deep-merge; scalars prefer incoming-if-present.
  const merged = mergePreferIncoming(existing, incoming);
  merged.documents = mergeDocuments(existing.documents, incoming.documents);
  merged.sources = { ...(existing.sources || {}), ...(incoming.sources || {}) };
  merged.raw_sources = { ...(existing.raw_sources || {}), ...(incoming.raw_sources || {}) };
  merged.createdAt = existing.createdAt || now;
  merged.gmp = existing.gmp || incoming.gmp || null; // GMP managed by its own endpoint
  delete merged._id;

  const changes = diffFields(existing, merged);
  if (changes.length === 0) {
    // touch source lastFetched only
    await ipos.updateOne({ _id: existing._id }, { $set: { sources: merged.sources } });
    return { action: 'unchanged', slug: merged.slug, changes: [] };
  }
  merged.updatedAt = now;
  await ipos.updateOne({ _id: existing._id }, { $set: merged });
  return { action: 'updated', slug: merged.slug, changes };
}

/** Which meaningful top-level fields changed (ignores timestamps/sources/raw). */
function diffFields(a, b) {
  const watch = ['status', 'priceBand', 'lotSize', 'issueSize', 'listingDate', 'biddingStart', 'biddingEnd', 'issuePrice', 'documents', 'subscription'];
  const changed = [];
  for (const k of watch) {
    if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) changed.push(k);
  }
  return changed;
}

async function findBySlug(slug) {
  return collections.ipos().findOne({ slug });
}

/**
 * Query with filters/sort/pagination/search.
 * @param {object} q
 */
async function query(q = {}) {
  const ipos = collections.ipos();
  const filter = {};
  if (q.status) filter.status = q.status;
  if (q.source) filter[`sources.${q.source}`] = { $exists: true };
  if (q.document) filter[`documents.${q.document}`] = { $exists: true };
  if (q.search) {
    filter.$or = [
      { companyName: { $regex: q.search, $options: 'i' } },
      { symbol: { $regex: q.search, $options: 'i' } },
      { isin: { $regex: q.search, $options: 'i' } },
    ];
  }

  // Default: latest IPOs first (by bidding date), then most-recently-updated.
  const sortField = ({
    listingDate: 'listingDate', name: 'companyName', createdAt: 'createdAt',
    biddingStart: 'biddingStart', date: 'biddingStart', latest: 'biddingStart',
  })[q.sort] || 'biddingStart';
  const order = q.order === 'asc' ? 1 : -1;
  const sortSpec = sortField === 'companyName'
    ? { companyName: order }
    : { [sortField]: order, updatedAt: -1, createdAt: -1 };
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 50));

  const total = await ipos.countDocuments(filter);
  const data = await ipos.find(filter)
    .sort(sortSpec)
    .skip((page - 1) * limit)
    .limit(limit)
    .toArray();

  return { data, pagination: { page, limit, total, hasMore: page * limit < total } };
}

async function deleteBySlug(slug) {
  return collections.ipos().deleteOne({ slug });
}

/** Append an error to an IPO's rolling log (keeps the last 5 per the data model). */
async function recordError(slug, operation, message) {
  const entry = { operation, error: String(message), at: new Date().toISOString() };
  await collections.ipos().updateOne(
    { slug },
    { $push: { errors: { $each: [entry], $slice: -5 } } },
  );
}

module.exports = { upsertRecord, findBySlug, query, deleteBySlug, recordError, findExisting, resolveSlug, diffFields, mergeDocuments };
