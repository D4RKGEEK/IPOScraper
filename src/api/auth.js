'use strict';

/**
 * auth.js — simple, optional, .env-based auth for the dashboard/control panel.
 *
 * Single shared admin login (no user management — this is an internal control
 * panel). Credentials come from the environment:
 *   DASHBOARD_USER      (default 'admin')
 *   DASHBOARD_PASSWORD  (if unset → auth is DISABLED; everything is open)
 *   DASHBOARD_SECRET    (HMAC signing key; falls back to a value derived from
 *                        the password so it still works if you don't set one)
 *
 * Tokens are stateless HMAC-signed strings: base64url(payload).hexHmac.
 * The guard accepts the token via the `Authorization: Bearer <t>` header OR a
 * `?token=` query param (the latter so <iframe>/<img> requests like the PDF
 * preview, which can't set headers, can still authenticate).
 */

const crypto = require('crypto');
const { logger } = require('../utils/logger');

const log = logger.child({ module: 'auth' });

const USER = process.env.DASHBOARD_USER || 'admin';
const PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const SECRET = process.env.DASHBOARD_SECRET || (PASSWORD ? `derived:${PASSWORD}` : 'insecure-dev-secret');
const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days

/** Auth is only enforced when a password is configured. */
const authEnabled = () => !!PASSWORD;

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('hex');

/** Constant-time string compare (avoids timing leaks on the password check). */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function signToken(username) {
  const payload = b64url(JSON.stringify({ u: username, exp: Date.now() + TOKEN_TTL_MS }));
  return `${payload}.${hmac(payload)}`;
}

/** @returns {object|null} the payload if valid & unexpired, else null. */
function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig || !safeEqual(sig, hmac(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

/** Validate username + password against the configured credentials. */
function checkCredentials(username, password) {
  return safeEqual(username || '', USER) && safeEqual(password || '', PASSWORD);
}

/** Express handler: POST /auth/login { username, password } → { token, user }. */
function loginHandler(req, res) {
  if (!authEnabled()) return res.json({ token: null, user: USER, authEnabled: false });
  const { username, password } = req.body || {};
  if (!checkCredentials(username, password)) {
    log.warn({ username }, 'failed login');
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  res.json({ token: signToken(username), user: username, authEnabled: true });
}

/** Express middleware: rejects requests without a valid token (when enabled). */
function authGuard(req, res, next) {
  if (!authEnabled()) return next();
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const token = bearer || req.query.token;
  if (verifyToken(token)) return next();
  return res.status(401).json({ error: 'Authentication required' });
}

module.exports = { authEnabled, signToken, verifyToken, loginHandler, authGuard, DASHBOARD_USER: USER };
