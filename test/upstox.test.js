import { test, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const axios = require('axios');

const { fetchUpstoxIpos, mapUpstoxRecord } = require('../utils/upstox.js');

beforeEach(() => {
  vi.restoreAllMocks();
});

test('mapUpstoxRecord maps detail payload correctly', () => {
  const rawDetail = {
    id: "genxai-analytics-limited-ipo",
    symbol: "GENXAI",
    name: "Genxai Analytics IPO",
    status: "open",
    isin: "INE1W0N01014",
    issue_type: "sme",
    issue_size: 55,
    minimum_price: 110,
    maximum_price: 116,
    bidding_start_date: "2026-06-05",
    rhp_url: "https://assets.upstox.com/ipo/documents/rhp/genxai-analytics-rhp.pdf",
    drhp_url: null
  };
  
  const result = mapUpstoxRecord(rawDetail);
  expect(result.isin).toBe("INE1W0N01014");
  expect(result.symbol).toBe("GENXAI");
  expect(result.companyName).toBe("Genxai Analytics");
  expect(result.status).toBe("open");
  expect(result.biddingStartDate).toBe("2026-06-05");
  expect(result.priceBand.minimum).toBe(110);
  expect(result.priceBand.maximum).toBe(116);
  expect(result.documentUrls.rhp).toBe("https://assets.upstox.com/ipo/documents/rhp/genxai-analytics-rhp.pdf");
  expect(result.documentUrls.drhp).toBeNull();
  expect(result.raw_sources.upstox).toEqual(rawDetail);
});

test('fetchUpstoxIpos queries list and detail and handles standard flow', async () => {
  process.env.UPSTOX_ACCESS_TOKEN = 'test-token';
  
  const mockGet = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    if (url.includes('page_number=')) {
      return {
        data: {
          data: [{ id: 'test-ipo' }],
          meta_data: { page: { total_pages: 1 } }
        }
      };
    } else if (url.includes('/test-ipo')) {
      return {
        data: {
          data: {
            id: 'test-ipo',
            symbol: 'TEST',
            name: 'Test IPO',
            status: 'listed',
            isin: 'INE000000000',
            minimum_price: 100,
            maximum_price: 105,
            bidding_start_date: '2026-06-01',
            rhp_url: 'https://example.com/rhp.pdf'
          }
        }
      };
    }
    throw new Error('Unexpected URL');
  });

  const ipos = await fetchUpstoxIpos();
  expect(ipos.length).toBe(3); // 3 statuses (upcoming, open, closed — listed dropped)
  expect(ipos[0].symbol).toBe('TEST');
  expect(ipos[0].priceBand.minimum).toBe(100);
  expect(mockGet).toHaveBeenCalled();
});
