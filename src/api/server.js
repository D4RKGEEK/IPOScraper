'use strict';

/**
 * server.js — IPO platform API entry point.
 * Connects MongoDB, builds the Express app (scraper routes + the document
 * extraction pipeline mounted at /v1), and listens. ONE process, ONE port.
 *
 * Run with `npm start` (tsx — required so the TypeScript extraction module
 * loads). Plain `node src/api/server.js` still works: the scraper boots and
 * extraction is simply disabled with a warning.
 */

require('dotenv').config();

const { buildApp } = require('./app');
const { connect } = require('../db/mongo');
const { logger } = require('../utils/logger');

const PORT = process.env.PORT || 3001;

async function main() {
  await connect();

  // Extraction pipeline (PRD v2.1): mounted at /v1, worker in this process.
  // Disabled gracefully when env vars are missing or not running under tsx.
  let v1Router = null;
  try {
    const { createExtraction } = require('../extraction/bootstrap');
    v1Router = (await createExtraction()).router;
    logger.info('extraction pipeline mounted at /v1 (worker running)');
  } catch (e) {
    logger.warn({ reason: e.message }, 'extraction pipeline disabled');
  }

  const app = buildApp({ v1Router });
  app.listen(PORT, () => {
    logger.info({ port: PORT }, 'IPO API started');
  });
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
