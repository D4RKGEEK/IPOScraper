'use strict';

/**
 * zerodha.js — Zerodha IPO source (HTML scrape; no API).
 *
 *   homepage https://zerodha.com/ipo/         -> list of IPOs + detail links
 *   detail   https://zerodha.com/ipo/<id>/<slug>/  -> "Download prospectus (PDF)" link
 *
 * Zerodha's value here is the DOCUMENT link (prospectus PDF) plus metadata
 * (symbol/type/dates/price). The doc type is inferred from the PDF filename:
 *   contains "drhp" -> drhp ; else "final" -> final ; else "rhp" -> rhp ;
 *   else default "drhp".
 *
 * No ISIN is available, so run_pipeline's dedup falls back to symbol / Jaro-Winkler
 * name + 30-day date guard. Output is the shared standardized record
 * (raw_sources.zerodha).
 */

const axios = require('axios');
const cheerio = require('cheerio');
const { parseIndianDate, formatDateISO } = require('../utils/normalizers.js');

const BASE = 'https://zerodha.com';
const LIST_URL = `${BASE}/ipo/`;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getHtml(url, retries = 3, delay = 800) {
  try {
    const res = await axios.get(url, { headers: HEADERS, timeout: 20000 });
    return res.data;
  } catch (e) {
    const status = e.response && e.response.status;
    if ((status === 429 || (status >= 500 && status < 600) || !status) && retries > 0) {
      await sleep(delay);
      return getHtml(url, retries - 1, delay * 2);
    }
    throw e;
  }
}

/**
 * Classify a prospectus document type from its URL/filename.
 * Defaults to 'drhp' when the name says nothing.
 */
function classifyDocFromUrl(url) {
  if (!url) return null;
  const lurl = url.toLowerCase();
  if (lurl.includes('drhp') || lurl.includes('draft')) return 'drhp';
  if (lurl.includes('rhp') || lurl.includes('red-herring')) return 'rhp';
  if (lurl.includes('final')) return 'final';
  return 'drhp';
}

/** Parse "₹42 – ₹45" / "₹110 ₹116" into a price band. */
function parsePriceBand(text) {
  const nums = (String(text || '').match(/\d[\d,]*/g) || []).map((n) => Number(n.replace(/,/g, '')));
  if (!nums.length) return { minimum: null, maximum: null };
  return { minimum: nums[0], maximum: nums.length > 1 ? nums[1] : nums[0] };
}

/**
 * Parse a Zerodha bidding range like "05th – 09th Jun 2026" into ISO start/end.
 * Month + year live only at the end and apply to both days.
 */
function parseDateRange(text) {
  const s = String(text || '').replace(/(\d+)(st|nd|rd|th)/gi, '$1').trim();
  if (!s) return { start: null, end: null };
  const monthYear = (s.match(/([A-Za-z]{3,9})\s+(\d{4})/) || [])[0]; // "Jun 2026"
  const days = s.match(/\b(\d{1,2})\b/g) || [];
  if (!monthYear || !days.length) {
    const single = parseIndianDate(s);
    const iso = single ? formatDateISO(single) : null;
    return { start: iso, end: iso };
  }
  const startD = parseIndianDate(`${days[0]} ${monthYear}`);
  const endD = parseIndianDate(`${days[days.length - 1]} ${monthYear}`);
  return { start: startD ? formatDateISO(startD) : null, end: endD ? formatDateISO(endD) : null };
}

/** Best-effort status from dates (Zerodha status is secondary; merge keeps existing). */
function inferStatus(startISO, endISO, listingISO, now = new Date()) {
  const today = formatDateISO(now);
  if (listingISO && listingISO < today) return 'listed';
  if (endISO && endISO < today) return 'closed';
  if (startISO && startISO > today) return 'upcoming';
  if (startISO && endISO && startISO <= today && today <= endISO) return 'open';
  return null;
}

/**
 * Parse the homepage list into row objects.
 * @returns {Array<{symbol, isSme, companyName, detailPath, biddingRange, listingDateText, priceText}>}
 */
function parseList(html) {
  const $ = cheerio.load(html);
  const rows = [];
  const seen = new Set();
  $('tr').each((_, tr) => {
    const $tr = $(tr);
    const a = $tr.find('td.name a, td.ipo-logo a').first();
    const href = a.attr('href');
    if (!href || !/^\/ipo\/\d+\//.test(href)) return;
    const detailPath = href.replace(/\/?$/, '/'); // normalize trailing slash
    if (seen.has(detailPath)) return; // logo + name both link; take one
    seen.add(detailPath);

    const $sym = $tr.find('.ipo-symbol').first().clone();
    const type = $sym.find('.ipo-type').text().trim();
    $sym.find('.ipo-type').remove();
    const symbol = $sym.text().trim();
    const companyName = $tr.find('.ipo-name').first().text().trim();

    const dateCells = $tr.find('td.date');
    const biddingRange = $(dateCells.get(0)).clone().children('.hidden').remove().end().text().trim();
    const listingDateText = dateCells.length > 1 ? $(dateCells.get(1)).text().trim() : '';
    const priceText = $tr.find('td.text-right').first().text().trim();

    rows.push({ symbol, isSme: /sme/i.test(type), type, companyName, detailPath, biddingRange, listingDateText, priceText });
  });
  return rows;
}

/** Extract the prospectus PDF URL from a detail page. */
function parseDetailProspectus(html) {
  const $ = cheerio.load(html);
  let url = null;
  $('a[href$=".pdf"], a[href*=".pdf"]').each((_, a) => {
    if (url) return;
    const text = $(a).text().trim().toLowerCase();
    const href = $(a).attr('href');
    if (/prospectus/.test(text) && /\.pdf/i.test(href)) url = href;
  });
  return url;
}

/** Map a parsed row (+ optional prospectus URL) into a standardized record. */
function mapZerodhaRecord(row, prospectusUrl, now = new Date()) {
  const { start, end } = parseDateRange(row.biddingRange);
  const listingD = parseIndianDate(row.listingDateText);
  const listingISO = listingD ? formatDateISO(listingD) : null;
  const docType = classifyDocFromUrl(prospectusUrl);
  const documentUrls = { rhp: null, drhp: null };
  if (prospectusUrl && docType) documentUrls[docType === 'final' ? 'rhp' : docType] = prospectusUrl;

  return {
    isin: null, // not exposed by Zerodha
    symbol: row.symbol || null,
    companyName: row.companyName || null,
    status: inferStatus(start, end, listingISO, now),
    biddingStartDate: start,
    priceBand: parsePriceBand(row.priceText),
    documentUrls,
    listingDate: listingISO || undefined,
    raw_sources: {
      zerodha: {
        symbol: row.symbol, type: row.type, isSme: row.isSme,
        detailUrl: `${BASE}${row.detailPath}`,
        biddingRange: row.biddingRange, listingDate: listingISO,
        prospectusUrl: prospectusUrl || null, docType,
      },
    },
  };
}

/**
 * Scrape Zerodha IPOs into standardized records.
 * @param {object} [opts]
 * @param {boolean} [opts.fetchDetails=true] open each detail page for the prospectus link
 * @param {number} [opts.detailDelayMs=150]
 * @param {number} [opts.maxDetails]
 * @returns {Promise<object[]>}
 */
async function fetchZerodhaIpos(opts = {}) {
  const fetchDetails = opts.fetchDetails !== false;
  const includeListed = opts.includeListed === true; // listed IPOs no longer update
  const delay = opts.detailDelayMs ?? 150;
  const now = new Date();

  let listHtml;
  try {
    listHtml = await getHtml(LIST_URL);
  } catch (e) {
    throw new Error(`Zerodha list fetch failed: ${e.message}`);
  }
  const rows = parseList(listHtml);

  const records = [];
  let count = 0;
  for (const row of rows) {
    // Skip listed IPOs up front (no updates) — also avoids their detail fetch.
    if (!includeListed) {
      const { start, end } = parseDateRange(row.biddingRange);
      const ld = parseIndianDate(row.listingDateText);
      if (inferStatus(start, end, ld ? formatDateISO(ld) : null, now) === 'listed') continue;
    }
    let prospectusUrl = null;
    if (fetchDetails && (opts.maxDetails == null || count < opts.maxDetails)) {
      try {
        const detailHtml = await getHtml(`${BASE}${row.detailPath}`);
        prospectusUrl = parseDetailProspectus(detailHtml);
      } catch (_) { /* detail best-effort */ }
      count++;
      if (delay) await sleep(delay);
    }
    records.push(mapZerodhaRecord(row, prospectusUrl, now));
  }
  return records;
}

module.exports = {
  fetchZerodhaIpos, parseList, parseDetailProspectus, mapZerodhaRecord,
  classifyDocFromUrl, parsePriceBand, parseDateRange, inferStatus, LIST_URL,
};
