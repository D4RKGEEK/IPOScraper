'use strict';

/**
 * configRepository.js — persistence for the dashboard-editable extraction
 * config (the field schema + the section dictionary).
 *
 * MongoDB is the source of truth (the filesystem is ephemeral on Railway). The
 * built-in defaults in llm/schema.js and config.js are the seed; whatever is
 * saved here overrides them at runtime.
 *
 * `config` collection documents:
 *   { _id: 'schema',   fields: { … } }                    // FIELDS registry
 *   { _id: 'sections', aliases: { … }, targets: [ … ] }   // SECTION_ALIASES + TARGET_SECTIONS
 */

const { collections } = require('./mongo');
const schemaStore = require('../extraction/llm/schema');
const sectionConfig = require('../extraction/config');
const validation = require('../extraction/validate');
const { getCascadeOrder, setCascadeOrder, resetCascade, getDefaultCascade } = require('../extraction/config');
const { logger } = require('../utils/logger');

const log = logger.child({ module: 'config-repo' });

/**
 * Load persisted config from MongoDB and apply it to the in-memory stores.
 * Falls back to the built-in defaults (and self-heals) if a stored doc is
 * invalid. Safe to call once at startup.
 */
async function loadConfig() {
  // ── Schema ──────────────────────────────────────────────────────────────
  try {
    const doc = await collections.config().findOne({ _id: 'schema' });
    if (doc && doc.fields) {
      schemaStore.setFields(doc.fields); // validates; throws on bad data
      log.info({ fields: Object.keys(doc.fields).length }, 'loaded persisted schema');
    } else {
      log.info('no persisted schema; using built-in default');
    }
  } catch (e) {
    log.warn({ err: e.message }, 'persisted schema invalid; keeping built-in default');
  }

  // ── Sections ────────────────────────────────────────────────────────────
  try {
    const doc = await collections.config().findOne({ _id: 'sections' });
    if (doc) {
      if (doc.aliases) sectionConfig.setSectionAliases(doc.aliases);
      if (doc.targets) sectionConfig.setTargetSections(doc.targets);
      log.info({ targets: sectionConfig.getTargetSections().length }, 'loaded persisted sections');
    } else {
      log.info('no persisted sections; using built-in default');
    }
  } catch (e) {
    log.warn({ err: e.message }, 'persisted sections invalid; keeping built-in default');
  }

  // ── Validation rules ──────────────────────────────────────────────────────
  try {
    const doc = await collections.config().findOne({ _id: 'validation' });
    if (doc && doc.rules) {
      validation.setRules(doc.rules); // validates; throws on bad data
      if (doc.threshold != null) validation.setThreshold(doc.threshold);
      log.info({ rules: doc.rules.length }, 'loaded persisted validation rules');
    } else {
      log.info('no persisted validation rules; using built-in default');
    }
  } catch (e) {
    log.warn({ err: e.message }, 'persisted validation rules invalid; keeping built-in default');
  }

  // ── Cascade order ─────────────────────────────────────────────────────────
  try {
    const doc = await collections.config().findOne({ _id: 'cascade' });
    if (doc && doc.order) {
      setCascadeOrder(doc.order);
      log.info({ order: getCascadeOrder() }, 'loaded persisted cascade order');
    } else {
      log.info('no persisted cascade; using built-in default');
    }
  } catch (e) {
    log.warn({ err: e.message }, 'persisted cascade invalid; keeping built-in default');
  }
}

// ── Backups ──────────────────────────────────────────────────────────────────
// Every change to a config doc (schema / sections / validation), whether manual
// or AI-assisted, snapshots the PREVIOUS persisted version into `config_backups`
// first — so any edit is reversible. We keep the last MAX_BACKUPS per key.

const { ObjectId } = require('mongodb');
const MAX_BACKUPS = 25;

/** Snapshot the current persisted config doc for `key` before it is overwritten. */
async function backupConfig(key, reason = 'edit') {
  const current = await collections.config().findOne({ _id: key });
  if (!current) return null; // nothing persisted yet (still on built-in default)
  const { _id, ...snapshot } = current;
  const res = await collections.configBackups().insertOne({
    key, snapshot, reason, createdAt: new Date().toISOString(),
  });
  // Prune to the most recent MAX_BACKUPS for this key.
  const stale = await collections.configBackups()
    .find({ key }).sort({ createdAt: -1 }).skip(MAX_BACKUPS).project({ _id: 1 }).toArray();
  if (stale.length) await collections.configBackups().deleteMany({ _id: { $in: stale.map((d) => d._id) } });
  return res.insertedId.toString();
}

/** List recent backups for a key (newest first), without the full snapshot blob. */
async function listBackups(key) {
  const filter = key ? { key } : {};
  const docs = await collections.configBackups()
    .find(filter).sort({ createdAt: -1 }).limit(MAX_BACKUPS).toArray();
  return docs.map((d) => ({
    id: d._id.toString(),
    key: d.key,
    reason: d.reason,
    createdAt: d.createdAt,
    summary: d.key === 'validation'
      ? { rules: d.snapshot.rules?.length, threshold: d.snapshot.threshold }
      : d.key === 'schema'
        ? { fields: Object.keys(d.snapshot.fields || {}).length }
        : { targets: d.snapshot.targets?.length },
  }));
}

/**
 * Restore a backup by id. Re-applies its snapshot through the SAME validating
 * save path (so it can't restore invalid data), backing up the current state
 * first. Returns the restored config.
 */
async function restoreBackup(id) {
  let _id;
  try { _id = new ObjectId(id); } catch { throw new Error('invalid backup id'); }
  const b = await collections.configBackups().findOne({ _id });
  if (!b) throw new Error('backup not found');
  const s = b.snapshot || {};
  switch (b.key) {
    case 'schema': return saveSchema(s.fields, `restore:${id}`);
    case 'sections': return saveSections({ aliases: s.aliases, targets: s.targets }, `restore:${id}`);
    case 'validation': return saveValidation({ rules: s.rules, threshold: s.threshold }, `restore:${id}`);
    default: throw new Error(`cannot restore unknown config key "${b.key}"`);
  }
}

/**
 * Validate + apply + persist a new field schema. Throws (without persisting)
 * if the candidate is invalid.
 * @param {object} fields  Candidate FIELDS registry
 * @returns {Promise<object>} The applied (sanitized) fields
 */
async function saveSchema(fields, reason = 'edit') {
  const applied = schemaStore.setFields(fields); // validates first
  await backupConfig('schema', reason);          // snapshot previous version
  await collections.config().updateOne(
    { _id: 'schema' },
    { $set: { fields: applied, updatedAt: new Date().toISOString() } },
    { upsert: true },
  );
  log.info({ fields: Object.keys(applied).length }, 'schema saved');
  return applied;
}

/** Reset schema to the built-in default and clear the persisted override. */
async function resetSchema() {
  schemaStore.resetFields();
  await collections.config().deleteOne({ _id: 'schema' });
  log.info('schema reset to default');
  return schemaStore.getFields();
}

/**
 * Validate + apply + persist section config. Either field is optional; both
 * are validated against each other (targets must be known aliases).
 * @param {object} opts
 * @param {object} [opts.aliases]  SECTION_ALIASES dictionary
 * @param {string[]} [opts.targets]  TARGET_SECTIONS list
 */
async function saveSections({ aliases, targets } = {}, reason = 'edit') {
  if (aliases) sectionConfig.setSectionAliases(aliases);
  if (targets) sectionConfig.setTargetSections(targets);
  await backupConfig('sections', reason);
  await collections.config().updateOne(
    { _id: 'sections' },
    {
      $set: {
        aliases: sectionConfig.getSectionAliases(),
        targets: sectionConfig.getTargetSections(),
        updatedAt: new Date().toISOString(),
      },
    },
    { upsert: true },
  );
  log.info({ targets: sectionConfig.getTargetSections().length }, 'sections saved');
  return { aliases: sectionConfig.getSectionAliases(), targets: sectionConfig.getTargetSections() };
}

/** Reset sections to defaults and clear the persisted override. */
async function resetSections() {
  sectionConfig.resetSections();
  await collections.config().deleteOne({ _id: 'sections' });
  log.info('sections reset to default');
  return { aliases: sectionConfig.getSectionAliases(), targets: sectionConfig.getTargetSections() };
}

/**
 * Validate + apply + persist cascade order. Throws (without persisting) if invalid.
 * @param {string[]} order  Array of engine names (e.g., ['firecrawl', 'gemini', 'deepseek', 'openai'])
 * @returns {Promise<string[]>} The applied order
 */
async function saveCascade(order, reason = 'edit') {
  setCascadeOrder(order); // validates first
  await backupConfig('cascade', reason);
  await collections.config().updateOne(
    { _id: 'cascade' },
    {
      $set: {
        order: getCascadeOrder(),
        updatedAt: new Date().toISOString(),
      },
    },
    { upsert: true },
  );
  log.info({ order: getCascadeOrder() }, 'cascade saved');
  return getCascadeOrder();
}

/** Reset cascade to defaults and clear the persisted override. */
async function resetCascadeOrder() {
  const defaultCascade = getDefaultCascade();
  resetCascade(); // calls the resetCascade from config.js
  await collections.config().deleteOne({ _id: 'cascade' });
  log.info('cascade reset to default');
  return { order: getCascadeOrder(), defaults: defaultCascade };
}

/**
 * Validate + apply + persist the validation ruleset (and optional threshold).
 * Throws (without persisting) if the candidate is invalid.
 * @param {object} opts
 * @param {object[]} [opts.rules]    candidate ruleset
 * @param {number}   [opts.threshold] pass/review cutoff (0–100)
 */
async function saveValidation({ rules, threshold } = {}, reason = 'edit') {
  if (rules) validation.setRules(rules);              // validates first
  if (threshold != null) validation.setThreshold(threshold);
  await backupConfig('validation', reason);
  await collections.config().updateOne(
    { _id: 'validation' },
    { $set: { rules: validation.getRules(), threshold: validation.getThreshold(), updatedAt: new Date().toISOString() } },
    { upsert: true },
  );
  log.info({ rules: validation.getRules().length }, 'validation rules saved');
  return { rules: validation.getRules(), threshold: validation.getThreshold() };
}

/** Reset validation rules to defaults and clear the persisted override. */
async function resetValidation() {
  validation.resetRules();
  await collections.config().deleteOne({ _id: 'validation' });
  log.info('validation rules reset to default');
  return { rules: validation.getRules(), threshold: validation.getThreshold() };
}

module.exports = {
  loadConfig,
  saveSchema, resetSchema,
  saveSections, resetSections,
  saveCascade, resetCascadeOrder,
  saveValidation, resetValidation,
  backupConfig, listBackups, restoreBackup,
};
