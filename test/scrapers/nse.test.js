import { test, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { NSE } = require('nse-bse-api');
const { fetchNseIpos, mapNseRecord, parsePriceRange } = require('../../src/scrapers/nse.js');

beforeEach(() => {
  vi.restoreAllMocks();
});

test('parsePriceRange parses Rs. format correctly', () => {
  expect(parsePriceRange('Rs.326 to Rs.343')).toEqual({ minimum: 326, maximum: 343 });
  expect(parsePriceRange('Rs.42 - Rs.45')).toEqual({ minimum: 42, maximum: 45 });
  expect(parsePriceRange('343')).toEqual({ minimum: 343, maximum: 343 });
  expect(parsePriceRange('')).toEqual({ minimum: null, maximum: null });
});

test('mapNseRecord maps raw listings correctly', () => {
  const rawItem = {
    companyName: "Q-Line Biotech Limited",
    ipoEndDate: "25-MAY-2026",
    ipoStartDate: "21-MAY-2026",
    issuePrice: "343",
    listingDate: "29-MAY-2026",
    priceRange: "Rs.326 to Rs.343",
    securityType: "SME",
    symbol: "QLINE"
  };

  const result = mapNseRecord(rawItem);
  expect(result.isin).toBeNull();
  expect(result.symbol).toBe("QLINE");
  expect(result.companyName).toBe("Q-Line Biotech Limited");
  expect(result.status).toBeNull(); // status is not in rawItem
  expect(result.biddingStartDate).toBe("2026-05-21");
  expect(result.priceBand.minimum).toBe(326);
  expect(result.priceBand.maximum).toBe(343);
  expect(result.raw_sources.nse).toEqual(rawItem);
});

test('fetchNseIpos maps listing categories and queries detail info', async () => {
  const listCurrentSpy = vi.spyOn(NSE.prototype, 'listCurrentIPO').mockResolvedValue([
    {
      companyName: "Hexagon Nutrition Limited",
      issueStartDate: "05-Jun-2026",
      issuePrice: "Rs.42 to Rs.45",
      status: "Active",
      symbol: "HEXAGON"
    }
  ]);

  const listUpcomingSpy = vi.spyOn(NSE.prototype, 'listUpcomingIPO').mockResolvedValue([]);
  
  const listPastSpy = vi.spyOn(NSE.prototype, 'listPastIPO').mockResolvedValue([
    {
      companyName: "Q-Line Biotech Limited",
      ipoStartDate: "21-MAY-2026",
      priceRange: "Rs.326 to Rs.343",
      symbol: "QLINE"
    }
  ]);

  const getDetailsSpy = vi.spyOn(NSE.prototype, 'getIpoDetails').mockResolvedValue({
    companyName: "Q-Line Biotech Limited",
    metaInfo: {
      symbol: "QLINE",
      isin: "INE1G2W01011"
    }
  });

  const exitSpy = vi.spyOn(NSE.prototype, 'exit').mockImplementation(() => {});

  const result = await fetchNseIpos('/tmp', new Date('2026-05-01'), new Date('2026-06-10'));
  expect(result.length).toBe(2);
  
  const qline = result.find(r => r.symbol === 'QLINE');
  expect(qline).toBeDefined();
  expect(qline.isin).toBe("INE1G2W01011");
  expect(qline.status).toBe("closed");
  expect(qline.biddingStartDate).toBe("2026-05-21");
  
  expect(listCurrentSpy).toHaveBeenCalled();
  expect(listUpcomingSpy).toHaveBeenCalled();
  expect(listPastSpy).toHaveBeenCalled();
  expect(getDetailsSpy).toHaveBeenCalledWith({ symbol: 'QLINE' });
  expect(exitSpy).toHaveBeenCalled();
});
