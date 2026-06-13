'use strict';

/**
 * server.js — IPO platform API entry point.
 * Connects MongoDB, builds the Express app, and listens. ONE process, ONE port.
 */

require('dotenv').config();

const { buildApp } = require('./app');
const { connect } = require('../db/mongo');
const { loadConfig } = require('../db/configRepository');
const { logger } = require('../utils/logger');

const PORT = process.env.PORT || 3001;

async function main() {
  await connect();

  // Apply any dashboard-saved schema / section overrides before serving.
  await loadConfig();

  const app = buildApp();
  app.listen(PORT, () => {
    logger.info({ port: PORT }, 'IPO API started');
  });
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
