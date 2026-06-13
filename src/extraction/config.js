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
  CAPITAL_STRUCTURE: [
    'capital structure',
    'capitalisation statement',
    'capitalization statement',
  ],
  OBJECTS_OF_THE_OFFER: [
    'objects of the offer',
    'objects of the issue',
    'use of proceeds',
    'object of the offer',
  ],
  RESTATED_FINANCIAL_STATEMENTS: [
    'restated financial statements',
    'audited financial statements',
    'restated consolidated financial statements',
    'restated standalone financial statements',
    'financial statements',
  ],
  RISK_FACTORS: [
    'risk factors',
    'risk factor',
  ],
  OUR_BUSINESS: [
    'our business',
    'business overview',
    'overview of our business',
    'description of business',
  ],
  BASIS_FOR_OFFER_PRICE: [
    'basis for offer price',
    'basis for issue price',
    'basis of offer price',
  ],
  ABOUT_THE_ISSUER: [
    'about the issuer company',
    'about our company',
    'about us',
    'general information',
  ],
  DIVIDEND_POLICY: [
    'dividend policy',
    'dividends',
  ],
  OUTSTANDING_LITIGATION: [
    'outstanding litigation',
    'litigation and material developments',
    'legal proceedings',
  ],
  MANAGEMENT: [
    'our management',
    'board of directors',
    'our board of directors',
    'management',
  ],
  PROMOTERS: [
    'our promoter',
    'our promoters',
    'promoter group',
    'promoters and promoter group',
  ],
  INDUSTRY_OVERVIEW: [
    'industry overview',
    'industry',
    'our industry',
  ],
  REGULATIONS: [
    'regulations and policies',
    'key regulations',
    'regulations',
  ],
  FINANCIAL_INFORMATION: [
    'financial information',
    'financial data',
  ],
  HISTORY_AND_CORPORATE_STRUCTURE: [
    'history and certain corporate matters',
    'history and corporate structure',
    'our history',
  ],
  OFFER_STRUCTURE: [
    'offer structure',
    'issue structure',
    'terms of the offer',
    'terms of the issue',
  ],
  KEY_PERFORMANCE_INDICATORS: [
    'key performance indicators',
    'key operational and financial parameters',
  ],
  RELATED_PARTY_TRANSACTIONS: [
    'related party transactions',
  ],
  STOCK_MARKET_DATA: [
    'stock market data',
    'stock market information',
  ],
  ANCHOR_INVESTOR: [
    'anchor investor',
    'basis of allocation',
    'basis of allotment',
  ],
};

// ── Target sections (default set to extract) ─────────────────────────────────
const TARGET_SECTIONS = [
  'RISK_FACTORS',
  'CAPITAL_STRUCTURE',
  'OBJECTS_OF_THE_OFFER',
  'OUR_BUSINESS',
];

// ── Environment configuration ────────────────────────────────────────────────
const env = {
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
  FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY || '',
  FIRECRAWL_API_URL: process.env.FIRECRAWL_API_URL || 'https://api.firecrawl.dev/v2/parse',

  // Python executable path (override if using a venv)
  PYTHON_BIN: process.env.PYTHON_BIN || require('path').join(__dirname, 'python', '.venv', 'bin', 'python3'),

  // Output directories
  // Production: use /tmp (ephemeral, cleaned up after each run)
  // Development: use data/ (persists for debugging)
  OUTPUT_DIR: process.env.EXTRACTION_OUTPUT_DIR || (process.env.NODE_ENV === 'production' ? '/tmp/extraction' : 'data/output'),
  CACHE_DIR: process.env.EXTRACTION_CACHE_DIR || 'data/cache',
  PDF_DIR: process.env.EXTRACTION_PDF_DIR || (process.env.NODE_ENV === 'production' ? '/tmp/extraction/pdfs' : 'data/pdfs'),
};

module.exports = { SECTION_ALIASES, TARGET_SECTIONS, env };
