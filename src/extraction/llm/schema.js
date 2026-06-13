'use strict';

/**
 * schema.js — IPODetails JSON schema for structured LLM extraction.
 *
 * Used by Gemini (response_schema) and Firecrawl (schema option).
 * Mirrors the Python pipeline's Pydantic IPODetails model.
 */

const IPO_DETAILS_SCHEMA = {
  type: 'object',
  properties: {
    company_name: {
      type: 'string',
      description: 'Full legal name of the company',
    },
    company_description: {
      type: 'string',
      description: 'Brief description of the company and its business',
    },
    incorporation_date: {
      type: 'string',
      description: 'Date of incorporation (ISO format or as stated)',
    },
    registered_office: {
      type: 'string',
      description: 'Registered office address',
    },
    website: {
      type: 'string',
      description: 'Company website URL',
    },
    issue_type: {
      type: 'string',
      description: 'Type of issue: IPO, FPO, OFS, etc.',
    },
    face_value: {
      type: 'string',
      description: 'Face value per share (e.g., "₹10" or "Rs. 2")',
    },
    price_band: {
      type: 'string',
      description: 'Price band (e.g., "₹316 to ₹333 per share")',
    },
    lot_size: {
      type: 'string',
      description: 'Minimum lot size for bidding (e.g., "45 shares")',
    },
    issue_size: {
      type: 'string',
      description: 'Total issue size in rupees (e.g., "₹1,388.70 Crore")',
    },
    fresh_issue: {
      type: 'string',
      description: 'Fresh issue component (e.g., "₹500 Crore")',
    },
    offer_for_sale: {
      type: 'string',
      description: 'Offer for sale component (e.g., "Up to 1,00,00,000 equity shares")',
    },
    listing_at: {
      type: 'array',
      items: { type: 'string' },
      description: 'Stock exchanges where shares will be listed (e.g., ["BSE", "NSE"])',
    },
    promoters: {
      type: 'array',
      items: { type: 'string' },
      description: 'Names of the promoters',
    },
    promoter_holding_pre: {
      type: 'string',
      description: 'Promoter shareholding before the offer (percentage)',
    },
    promoter_holding_post: {
      type: 'string',
      description: 'Promoter shareholding after the offer (percentage)',
    },
    lead_managers: {
      type: 'array',
      items: { type: 'string' },
      description: 'Book Running Lead Managers (BRLMs)',
    },
    registrar: {
      type: 'string',
      description: 'Registrar to the offer',
    },
    sector: {
      type: 'string',
      description: 'Industry/sector the company operates in',
    },
    objects_of_the_offer: {
      type: 'array',
      items: { type: 'string' },
      description: 'List of stated objects/purposes of the offer',
    },
    risk_factors: {
      type: 'array',
      items: { type: 'string' },
      description: 'Key risk factors (top 10–15, summarized)',
    },
    reservations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Investor category (e.g., QIB, NII, Retail)' },
          percentage: { type: 'string', description: 'Percentage reserved (e.g., "50%")' },
        },
      },
      description: 'Category-wise reservation of shares',
    },
    financials: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          period: { type: 'string', description: 'Financial period (e.g., "FY 2024", "9M FY 2025")' },
          revenue: { type: 'string', description: 'Revenue / Total income' },
          pat: { type: 'string', description: 'Profit After Tax' },
          net_worth: { type: 'string', description: 'Net worth' },
          total_assets: { type: 'string', description: 'Total assets' },
          total_borrowings: { type: 'string', description: 'Total borrowings' },
          eps: { type: 'string', description: 'Earnings per share' },
          roe: { type: 'string', description: 'Return on equity (%)' },
          roce: { type: 'string', description: 'Return on capital employed (%)' },
        },
      },
      description: 'Restated financial statements by period',
    },
    pe_ratio: {
      type: 'string',
      description: 'Price-to-earnings ratio at upper band',
    },
    roce: {
      type: 'string',
      description: 'Return on capital employed',
    },
    roe: {
      type: 'string',
      description: 'Return on equity',
    },
    debt_to_equity: {
      type: 'string',
      description: 'Debt-to-equity ratio',
    },
    competitive_strengths: {
      type: 'array',
      items: { type: 'string' },
      description: 'Key competitive strengths listed in the prospectus',
    },
    business_strategies: {
      type: 'array',
      items: { type: 'string' },
      description: 'Key business strategies listed in the prospectus',
    },
  },
};

/**
 * Gemini-compatible schema: wraps the above in the format expected by
 * @google/genai's response_schema parameter.
 */
const GEMINI_SCHEMA = {
  type: 'object',
  properties: IPO_DETAILS_SCHEMA.properties,
};

module.exports = { IPO_DETAILS_SCHEMA, GEMINI_SCHEMA };
