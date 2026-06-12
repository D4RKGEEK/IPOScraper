const axios = require('axios');

/**
 * Sleep helper function
 * @param {number} ms 
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Helper to execute HTTP request with retry logic for 429 rate limit
 */
async function requestWithRetry(url, options, retries = 5, delay = 1500) {
  try {
    return await axios.get(url, options);
  } catch (error) {
    const status = error.response && error.response.status;
    const retryable = status === 429 || (status >= 500 && status < 600) || !status; // 429, 5xx, network
    if (retryable && retries > 0) {
      const retryAfter = error.response && error.response.headers && error.response.headers['retry-after'];
      // Respect Retry-After; else exponential backoff with jitter.
      const base = retryAfter ? parseInt(retryAfter, 10) * 1000 : delay;
      const waitTime = base + Math.floor(Math.random() * 400);
      console.warn(`[upstox] ${status || 'network'} — retrying in ${waitTime}ms (${retries} left)`);
      await sleep(waitTime);
      return requestWithRetry(url, options, retries - 1, delay * 2);
    }
    throw error;
  }
}

/**
 * Standardize raw Upstox detail payload into standardized schema.
 */
function mapUpstoxRecord(data) {
  return {
    isin: data.isin || null,
    symbol: data.symbol || null,
    companyName: data.name ? data.name.replace(/\s+IPO$/, '').trim() : null,
    status: data.status || null,
    biddingStartDate: data.bidding_start_date || (data.timeline && data.timeline.application_start_date) || null,
    priceBand: {
      minimum: data.minimum_price !== undefined && data.minimum_price !== null ? Number(data.minimum_price) : null,
      maximum: data.maximum_price !== undefined && data.maximum_price !== null ? Number(data.maximum_price) : null
    },
    documentUrls: {
      rhp: data.rhp_url || null,
      drhp: data.drhp_url || null
    },
    raw_sources: {
      upstox: data
    }
  };
}

/**
 * Queries active, upcoming, closed, and listed IPO listings and details from Upstox.
 * Standardizes the output schema and preserves raw payloads.
 * @returns {Promise<Array>} Standardized IPO entries
 */
async function fetchUpstoxIpos() {
  const token = process.env.UPSTOX_ACCESS_TOKEN;
  if (!token) {
    throw new Error('UPSTOX_ACCESS_TOKEN environment variable is missing');
  }

  // Listed IPOs no longer change, so we skip them — this also avoids the large
  // historical "listed" page set that was triggering 429s.
  const statuses = ['upcoming', 'open', 'closed'];
  const allIpos = [];

  for (const status of statuses) {
    let pageNumber = 1;
    let totalPages = 1;

    while (pageNumber <= totalPages) {
      const url = `https://api.upstox.com/v2/ipos?status=${status}&page_number=${pageNumber}`;
      const response = await requestWithRetry(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        }
      });

      if (response.data && response.data.data) {
        for (const item of response.data.data) {
          // Spacing buffer to respect rate limits
          await sleep(250);
          
          try {
            const detailUrl = `https://api.upstox.com/v2/ipos/${item.id}`;
            const detailResponse = await requestWithRetry(detailUrl, {
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/json'
              }
            });

            if (detailResponse.data && detailResponse.data.data) {
              allIpos.push(mapUpstoxRecord(detailResponse.data.data));
            } else {
              allIpos.push(mapUpstoxRecord(item));
            }
          } catch (detailError) {
            console.error(`Error fetching details for ${item.id}: ${detailError.message}`);
            // Fallback to list metadata if detail fails
            allIpos.push(mapUpstoxRecord(item));
          }
        }
      }

      if (response.data && response.data.meta_data && response.data.meta_data.page) {
        totalPages = response.data.meta_data.page.total_pages;
      } else {
        break;
      }
      pageNumber++;
    }
  }

  return allIpos;
}

module.exports = {
  fetchUpstoxIpos,
  mapUpstoxRecord
};
