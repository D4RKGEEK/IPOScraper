'use strict';

/**
 * logger.js — Centralized Pino logger for the IPO platform.
 * 
 * Usage:
 *   const { logger, requestLogger } = require('./logger');
 *   app.use(requestLogger);
 *   logger.info({ foo: 'bar' }, 'hello');
 */

const pino = require('pino');

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

// Create the main logger instance
const logger = pino({
  level: LOG_LEVEL,
  transport: process.env.NODE_ENV !== 'production' 
    ? { 
        target: 'pino-pretty', 
        options: { 
          colorize: true, 
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname,req,res,requestId'
        } 
      }
    : undefined,
});

/**
 * Express middleware for HTTP request logging.
 * Logs: method, path, status, response-time, request-id, ip
 */
function requestLogger(req, res, next) {
  const start = Date.now();
  
  // Generate or use existing request ID
  req.id = req.id || req.headers['x-request-id'] || Math.random().toString(36).slice(2, 15);
  
  res.on('finish', () => {
    // Skip logging successful polling, health, and static dashboard assets to prevent console clutter
    if (res.statusCode < 400) {
      const isJobPoll = req.path.startsWith('/jobs/');
      const isHealth = req.path === '/health';
      const isDashboard = req.path.startsWith('/dashboard') || req.path === '/';
      if (isJobPoll || isHealth || isDashboard) {
        return;
      }
    }

    const duration = Date.now() - start;
    const level = res.statusCode >= 400 ? 'warn' : 'info';
    
    logger[level]({
      req: {
        method: req.method,
        url: req.url,
        path: req.path,
        query: req.query,
        headers: { host: req.headers.host, 'user-agent': req.headers['user-agent'] },
        ip: req.ip || req.headers['x-forwarded-for'],
      },
      res: { statusCode: res.statusCode },
      responseTime: `${duration}ms`,
      requestId: req.id,
    }, `${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
  });
  
  next();
}

/**
 * Child logger with bound context (e.g., for a job or service)
 */
function child(bindings) {
  return logger.child(bindings);
}

module.exports = { logger, requestLogger, child };