const { NSE } = require('nse-bse-api');
const { parseIndianDate, formatDateISO } = require('../utils/normalizers.js');

/**
 * Parses a price range string (e.g. "Rs.326 to Rs.343", "Rs.42 to Rs.45", "100")
 * into a standardized priceBand object.
 * @param {string} rangeStr 
 * @returns {object} { minimum, maximum }
 */
function parsePriceRange(rangeStr) {
  if (!rangeStr) return { minimum: null, maximum: null };
  
  // Clean string: remove Rs., commas, whitespace
  const clean = rangeStr.replace(/Rs\.?/gi, '').replace(/,/g, '').trim();
  if (!clean) return { minimum: null, maximum: null };
  
  // Split on "to" or "-"
  const parts = clean.split(/\s+to\s+|\s*-\s*/i);
  if (parts.length === 2) {
    const min = Number(parts[0].trim());
    const max = Number(parts[1].trim());
    return {
      minimum: isNaN(min) ? null : min,
      maximum: isNaN(max) ? null : max
    };
  }
  
  const singlePrice = Number(clean);
  if (!isNaN(singlePrice) && singlePrice > 0) {
    return {
      minimum: singlePrice,
      maximum: singlePrice
    };
  }
  
  return { minimum: null, maximum: null };
}

/**
 * Maps raw NSE IPO records (from listPastIPO, listCurrentIPO, listUpcomingIPO)
 * into the standardized top-level schema.
 * @param {object} data Raw record
 * @returns {object} Standardized record
 */
function mapNseRecord(data) {
  // Extract symbol
  const symbol = data.symbol || null;

  // Company Name could be companyName or company
  const companyName = data.companyName || data.company || null;

  // Bidding start date
  const rawStartDate = data.ipoStartDate || data.issueStartDate || null;
  const biddingStartDate = rawStartDate ? formatDateISO(parseIndianDate(rawStartDate)) : null;

  // Status mapping
  let status = null;
  if (data.status) {
    const s = data.status.toLowerCase();
    if (s === 'active') status = 'open';
    else if (s === 'upcoming') status = 'upcoming';
    else if (s === 'closed' || s === 'past') status = 'closed';
    else status = s;
  }

  // Price range
  const priceBand = parsePriceRange(data.priceRange || data.issuePrice);

  return {
    isin: data.isin || (data.metaInfo && data.metaInfo.isin) || null,
    symbol: symbol,
    companyName: companyName,
    status: status,
    biddingStartDate: biddingStartDate,
    priceBand: priceBand,
    documentUrls: {
      rhp: data.rhpUrl || (data.metaInfo && data.metaInfo.rhpUrl) || null,
      drhp: data.drhpUrl || (data.metaInfo && data.metaInfo.drhpUrl) || null
    },
    raw_sources: {
      nse: data
    }
  };
}

/**
 * Fetches all IPO listings from NSE (current, upcoming, past)
 * standardizes the schema, and saves the session cookies.
 * @param {string} cookieDir Directory to persist cookies
 * @param {Date} fromDate Start date for past issues
 * @param {Date} toDate End date for past issues
 * @returns {Promise<Array>} Standardized IPO entries
 */
async function fetchNseIpos(cookieDir = '/Users/vaibhav/Desktop/nse', fromDate, toDate) {
  const nse = new NSE(cookieDir);
  const allIpos = new Map(); // Use map to deduplicate by symbol/name within the NSE feed

  try {
    // 1. Fetch Current IPOs
    try {
      const current = await nse.listCurrentIPO();
      if (Array.isArray(current)) {
        for (const item of current) {
          const mapped = mapNseRecord(item);
          if (mapped.symbol) {
            allIpos.set(`SYM:${mapped.symbol}`, mapped);
          }
        }
      }
    } catch (err) {
      console.error('Error fetching current NSE IPOs:', err.message);
    }

    // 2. Fetch Upcoming IPOs
    try {
      const upcoming = await nse.listUpcomingIPO();
      if (Array.isArray(upcoming)) {
        for (const item of upcoming) {
          const mapped = mapNseRecord(item);
          // Set status to upcoming if not already set
          if (!mapped.status) mapped.status = 'upcoming';
          if (mapped.symbol) {
            allIpos.set(`SYM:${mapped.symbol}`, mapped);
          }
        }
      }
    } catch (err) {
      console.error('Error fetching upcoming NSE IPOs:', err.message);
    }

    // 3. Fetch Past IPOs
    const start = fromDate || new Date('2022-01-01');
    const end = toDate || new Date();
    try {
      const past = await nse.listPastIPO(start, end);
      if (Array.isArray(past)) {
        for (const item of past) {
          const mapped = mapNseRecord(item);
          if (!mapped.status) mapped.status = 'closed';
          
          // Try to fetch detailed meta info (like ISIN) for past IPOs if symbol is available
          if (mapped.symbol && !mapped.isin) {
            try {
              // Add a small delay to avoid spamming the NSE API
              await new Promise(resolve => setTimeout(resolve, 100));
              const details = await nse.getIpoDetails({ symbol: mapped.symbol });
              if (details && details.metaInfo) {
                mapped.isin = details.metaInfo.isin || mapped.isin;
                if (details.metaInfo.listingDate) {
                  mapped.listingDate = details.metaInfo.listingDate;
                }
                // Merge raw details into raw_sources.nse
                mapped.raw_sources.nse = { ...mapped.raw_sources.nse, details };
              }
            } catch (detailErr) {
              // Ignore detail fetch errors, keep basic listing data
            }
          }

          const key = mapped.symbol ? `SYM:${mapped.symbol}` : `NAME:${mapped.companyName}`;
          allIpos.set(key, mapped);
        }
      }
    } catch (err) {
      console.error('Error fetching past NSE IPOs:', err.message);
    }

  } finally {
    nse.exit(); // Save cookies
  }

  return Array.from(allIpos.values());
}

module.exports = {
  fetchNseIpos,
  mapNseRecord,
  parsePriceRange
};
