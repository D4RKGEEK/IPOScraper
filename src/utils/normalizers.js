/**
 * Normalizes company names by converting to lowercase, stripping corporate suffixes,
 * removing non-alphanumeric characters, and squashing multiple spaces.
 * @param {string} name 
 * @returns {string}
 */
function normalizeCompanyName(name) {
  if (!name) return "";
  return name
    .toLowerCase()
    .replace(/\b(limited|ltd\.?|corporation|corp\.?|company|co\.?|ipo|details)\b/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalizes symbol names by converting to uppercase and stripping exchange suffixes.
 * @param {string} symbol 
 * @returns {string}
 */
function normalizeSymbol(symbol) {
  if (!symbol) return "";
  return symbol
    .toUpperCase()
    .replace(/-(BE|EQ)$/, "")
    .replace(/\.(NS|BO)$/, "")
    .trim();
}

/**
 * Standardizes various date string formats into local Date objects to prevent timezone shifts.
 * Supports YYYY-MM-DD, DD-MMM-YYYY, and space-separated variants.
 * @param {string} dateStr 
 * @returns {Date|null}
 */
function parseIndianDate(dateStr) {
  if (!dateStr) return null;
  
  const cleanStr = String(dateStr).trim();
  
  // Handle YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleanStr)) {
    const parts = cleanStr.split('-');
    return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  }
  
  // Handle DD-MMM-YYYY (e.g. 05-Jun-2026 or 25-MAY-2026)
  const parts = cleanStr.split('-');
  if (parts.length === 3) {
    const day = parseInt(parts[0], 10);
    const monthStr = parts[1].toUpperCase();
    const year = parseInt(parts[2], 10);
    
    const months = {
      JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
      JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11
    };
    
    const month = months[monthStr.substring(0, 3)];
    if (month !== undefined) {
      return new Date(year, month, day);
    }
  }

  // Handle space separated DD MMM YYYY
  const spaceParts = cleanStr.split(/\s+/);
  if (spaceParts.length === 3) {
    const day = parseInt(spaceParts[0], 10);
    const monthStr = spaceParts[1].toUpperCase();
    const year = parseInt(spaceParts[2], 10);
    
    const months = {
      JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
      JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11
    };
    
    const month = months[monthStr.substring(0, 3)];
    if (month !== undefined) {
      return new Date(year, month, day);
    }
  }
  
  const parsed = new Date(cleanStr);
  if (isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

/**
 * Formats a Date object to local YYYY-MM-DD to avoid timezone shifting.
 * @param {Date} dateObj 
 * @returns {string|null}
 */
function formatDateISO(dateObj) {
  if (!dateObj || isNaN(dateObj.getTime())) return null;
  const yyyy = dateObj.getFullYear();
  const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
  const dd = String(dateObj.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

module.exports = {
  normalizeCompanyName,
  normalizeSymbol,
  parseIndianDate,
  formatDateISO
};
