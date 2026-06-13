'use strict';

/**
 * pdf-bridge.js — Node ↔ Python bridge for PDF operations.
 *
 * Calls src/extraction/python/pdf_helper.py via child_process.execFile().
 * All communication is via JSON on stdout.
 */

const { execFile } = require('child_process');
const path = require('path');
const { env } = require('../config');
const { logger } = require('../../utils/logger');

const log = logger.child({ module: 'extraction:pdf-bridge' });

const HELPER_SCRIPT = path.join(__dirname, '..', 'python', 'pdf_helper.py');
const TIMEOUT_MS = 120_000; // 2 minutes per call (large PDFs)

/**
 * Run the Python helper script and return parsed JSON.
 * @param {string[]} args  Command + arguments for pdf_helper.py
 * @returns {Promise<any>} The "data" field from the JSON response
 */
function runPython(args) {
  return new Promise((resolve, reject) => {
    execFile(env.PYTHON_BIN, [HELPER_SCRIPT, ...args], {
      timeout: TIMEOUT_MS,
      maxBuffer: 50 * 1024 * 1024, // 50MB — pymupdf4llm can produce large markdown
    }, (err, stdout, stderr) => {
      if (err) {
        log.error({ args: args.slice(0, 2), stderr }, 'Python helper failed');
        return reject(new Error(`Python helper failed: ${err.message}`));
      }

      try {
        const result = JSON.parse(stdout);
        if (!result.ok) {
          return reject(new Error(`pdf_helper error: ${result.error}`));
        }
        resolve(result.data);
      } catch (parseErr) {
        log.error({ stdout: stdout.slice(0, 500) }, 'Failed to parse Python output');
        reject(new Error(`Failed to parse Python output: ${parseErr.message}`));
      }
    });
  });
}

/**
 * Get the total number of pages in a PDF.
 * @param {string} pdfPath  Absolute or relative path to the PDF file
 * @returns {Promise<number>}
 */
async function getPageCount(pdfPath) {
  return runPython(['page_count', pdfPath]);
}

/**
 * Extract raw text from a range of PDF pages.
 * @param {string} pdfPath
 * @param {number} startPage  0-indexed inclusive
 * @param {number} endPage    0-indexed inclusive
 * @returns {Promise<Array<{page: number, text: string}>>}
 */
async function getPageTexts(pdfPath, startPage, endPage) {
  return runPython(['text', pdfPath, String(startPage), String(endPage)]);
}

const CHUNK_SIZE = 15; // pages per Python call (large ranges can hang pymupdf4llm)

/**
 * Convert a range of PDF pages to markdown using pymupdf4llm.
 * Preserves tables, headings, bold text.
 *
 * Large ranges are chunked (CHUNK_SIZE pages at a time) to avoid
 * pymupdf4llm hanging on big page spans.
 *
 * @param {string} pdfPath
 * @param {number} startPage  0-indexed inclusive
 * @param {number} endPage    0-indexed inclusive
 * @returns {Promise<string>} Concatenated markdown text
 */
async function pagesToMarkdown(pdfPath, startPage, endPage) {
  const total = endPage - startPage + 1;
  if (total <= CHUNK_SIZE) {
    return runPython(['markdown', pdfPath, String(startPage), String(endPage)]);
  }

  log.info({ startPage, endPage, total, chunkSize: CHUNK_SIZE }, 'chunking large markdown conversion');

  const parts = [];
  for (let s = startPage; s <= endPage; s += CHUNK_SIZE) {
    const e = Math.min(s + CHUNK_SIZE - 1, endPage);
    const md = await runPython(['markdown', pdfPath, String(s), String(e)]);
    parts.push(md);
  }

  return parts.join('\n\n');
}

module.exports = { getPageCount, getPageTexts, pagesToMarkdown };
