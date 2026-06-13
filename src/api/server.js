'use strict';

/**
 * server.js — IPO platform API entry point.
 * Connects MongoDB, builds the Express app, and listens. ONE process, ONE port.
 */

require('dotenv').config();

const { buildApp } = require('./app');
const { connect } = require('../db/mongo');
const { logger } = require('../utils/logger');

const PORT = process.env.PORT || 3001;

async function main() {
  await connect();

  const app = buildApp();
  app.listen(PORT, () => {
    logger.info({ port: PORT }, 'IPO API started');
  });
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
