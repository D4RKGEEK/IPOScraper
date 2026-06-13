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
}

/**
 * Validate + apply + persist a new field schema. Throws (without persisting)
 * if the candidate is invalid.
 * @param {object} fields  Candidate FIELDS registry
 * @returns {Promise<object>} The applied (sanitized) fields
 */
async function saveSchema(fields) {
  const applied = schemaStore.setFields(fields); // validates first
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
async function saveSections({ aliases, targets } = {}) {
  if (aliases) sectionConfig.setSectionAliases(aliases);
  if (targets) sectionConfig.setTargetSections(targets);
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

module.exports = { loadConfig, saveSchema, resetSchema, saveSections, resetSections };
