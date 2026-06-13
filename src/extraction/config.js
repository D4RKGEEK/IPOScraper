'use strict';

/**
 * config.js — Extraction pipeline configuration.
 *
 * Section aliases map each target section key to an array of lowercase alias
 * strings. During ToC parsing, if any alias is a substring of a ToC heading,
 * that heading is matched to the section key.
 *
 * Environment variables are read once at import time and exported as constants.
 */

// ── Section aliases ──────────────────────────────────────────────────────────
// Each key is the canonical section name used throughout the pipeline.
// Values are lowercase alias substrings matched against ToC headings.
const SECTION_ALIASES = {
  GENERAL_INFORMATION: ["general information", "general information of the company"],
  CAPITAL_STRUCTURE: ["capital structure", "capital structure of the company", "capitalisation statement"],
  OBJECTS_OF_THE_OFFER: ["objects of the offer", "objects of the issue", "use of proceeds", "utilization of proceeds", "objects of the fresh issue"],
  BASIS_FOR_OFFER_PRICE: ["basis for offer price", "basis for issue price", "basis of offer price", "basis of issue price"],
  RESTATED_FINANCIAL_STATEMENTS: ["restated financial statements", "restated financial information", "restated consolidated financial statements", "audited financial statements"],
  RISK_FACTORS: ["risk factors"],
  OUR_MANAGEMENT: ["our management"],
  OUR_PROMOTERS_AND_PROMOTER_GROUP: ["our promoters and promoter group", "our promoters & promoter group"],
  DIVIDEND_POLICY: ["dividend policy"],
  INDUSTRY_OVERVIEW: ["industry overview"],
  OUR_BUSINESS: ["our business", "business overview"],
  STATEMENT_OF_SPECIAL_TAX_BENEFITS: ["statement of special tax benefits", "statement of possible special tax benefits", "statement of tax benefits"],
  OTHER_FINANCIAL_INFORMATION: ["other financial information"],
  STATEMENT_OF_FINANCIAL_INDEBTEDNESS: ["statement of financial indebtedness", "financial indebtedness"],
  OUTSTANDING_LITIGATION: ["outstanding litigation", "outstanding litigation and material developments"],
  ISSUE_PROCEDURE: ["issue procedure", "terms of the issue", "terms of the offer"],
  ISSUE_STRUCTURE: ["issue structure", "offer structure"],
  OUR_GROUP_COMPANIES: ["our group companies", "our group company"],
  KEY_REGULATIONS_AND_POLICIES: ["key regulations and policies", "key industry regulations and policies", "government and other approvals"],
  HISTORY_AND_CERTAIN_CORPORATE_MATTERS: ["history and certain corporate matters", "history and corporate structure"],
  ABOUT_THE_COMPANY: ["about the company", "about our company"],
};

// ── Target sections (default set to extract) ─────────────────────────────────
const TARGET_SECTIONS = ["RISK_FACTORS", "CAPITAL_STRUCTURE", "OBJECTS_OF_THE_OFFER", "OUR_BUSINESS"];

// ── Environment configuration ────────────────────────────────────────────────
const env = {
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
  FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY || '',
  FIRECRAWL_API_URL: process.env.FIRECRAWL_API_URL || 'https://api.firecrawl.dev/v2/parse',

  // Python executable path (override if using a venv)
  PYTHON_BIN: (() => {
    const p = process.env.PYTHON_BIN;
    if (p && p !== 'python3' && p !== 'python' && p !== 'python3.12') return p;
    return require('path').join(__dirname, 'python', '.venv', 'bin', 'python3');
  })(),

  // Output directories
  // Production: use /tmp (ephemeral, cleaned up after each run)
  // Development: use data/ (persists for debugging)
  OUTPUT_DIR: process.env.EXTRACTION_OUTPUT_DIR || (process.env.NODE_ENV === 'production' ? '/tmp/extraction' : 'data/output'),
  CACHE_DIR: process.env.EXTRACTION_CACHE_DIR || 'data/cache',
  PDF_DIR: process.env.EXTRACTION_PDF_DIR || (process.env.NODE_ENV === 'production' ? '/tmp/extraction/pdfs' : 'data/pdfs'),
};

module.exports = { SECTION_ALIASES, TARGET_SECTIONS, env };
