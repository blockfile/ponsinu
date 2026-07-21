'use strict';

const crypto = require('crypto');
const config = require('../config');

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Guards mutating endpoints with an API key. If API_KEY is unset, this is a no-op
 * (open) so local dev isn't blocked. When set, requests must send the key via
 * `x-api-key: <key>` or `Authorization: Bearer <key>`.
 */
function requireApiKey(req, res, next) {
  if (!config.apiKey) return next(); // not configured → open

  const fromHeader = req.get('x-api-key');
  const fromBearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const provided = fromHeader || fromBearer;

  if (provided && safeEqual(provided, config.apiKey)) return next();
  return res.status(401).json({ error: 'unauthorized — missing or invalid API key' });
}

module.exports = { requireApiKey };
