'use strict';

/**
 * slug.js — generate stable URL slugs for IPOs: "company-name-lowercase-ipo".
 */

/** Slugify a company name. Strips suffixes like "Limited"/"Ltd", non-alphanumerics. */
function slugify(companyName, opts = {}) {
  const base = String(companyName || 'unknown')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(limited|ltd\.?|private|pvt\.?|ipo)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-');
  let slug = base ? `${base}-ipo` : 'unknown-ipo';
  if (opts.suffix) slug += `-${String(opts.suffix).toLowerCase().replace(/[^a-z0-9]+/g, '')}`;
  return slug;
}

module.exports = { slugify };
