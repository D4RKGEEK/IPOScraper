'use strict';

/**
 * client.js — LLM client abstraction.
 *
 * callLlmJson(prompt)   — Gemini first → DeepSeek fallback. For JSON tasks
 *                          (ToC parsing, page classification).
 * callGeminiStructured(prompt, schema) — Gemini 2.5 Flash with response_schema.
 *                          For the final structured extraction.
 *
 * Uses @google/genai for Gemini and raw fetch() for DeepSeek (OpenAI-compatible API).
 */

const { env } = require('../config');
const { generateCacheKey, getCachedResponse, setCachedResponse } = require('../cache');
const { logger } = require('../../utils/logger');

const log = logger.child({ module: 'extraction:llm' });

// ── DeepSeek (OpenAI-compatible) ─────────────────────────────────────────────

async function callDeepSeek(prompt, maxTokens = 2000) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'You output strictly valid JSON without markdown formatting.' },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`DeepSeek API ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('DeepSeek returned empty content');
  return JSON.parse(text);
}

// ── Gemini ────────────────────────────────────────────────────────────────────

let _genaiClient = null;

function getGenaiClient() {
  if (!_genaiClient) {
    const { GoogleGenAI } = require('@google/genai');
    _genaiClient = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  }
  return _genaiClient;
}

async function callGeminiFreeform(prompt, maxTokens = 2000) {
  const client = getGenaiClient();
  const response = await client.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      maxOutputTokens: maxTokens,
    },
  });
  const text = response.text;
  if (!text) throw new Error('Gemini returned empty content');
  return JSON.parse(text);
}

/**
 * Call an LLM for a JSON task. Gemini first (default), DeepSeek fallback.
 *
 * @param {string} prompt     The full prompt
 * @param {object} [opts]
 * @param {number} [opts.maxTokens=2000]
 * @param {boolean} [opts.cache=true]   Whether to use disk cache
 * @param {string} [opts.cacheNs='llm'] Cache namespace
 * @returns {Promise<object>}  Parsed JSON response
 */
async function callLlmJson(prompt, opts = {}) {
  const { maxTokens = 2000, cache = true, cacheNs = 'llm' } = opts;

  // Check cache first
  if (cache) {
    const key = generateCacheKey(cacheNs, prompt);
    const cached = getCachedResponse(key);
    if (cached) return cached;
  }

  let result;

  // Try Gemini first (default)
  if (env.GEMINI_API_KEY) {
    try {
      log.debug('calling Gemini');
      result = await callGeminiFreeform(prompt, maxTokens);
      log.debug('Gemini succeeded');
    } catch (e) {
      log.warn({ err: e.message }, 'Gemini failed, falling back to DeepSeek');
    }
  }

  // DeepSeek fallback
  if (!result) {
    if (!env.DEEPSEEK_API_KEY) throw new Error('No LLM API key available (Gemini failed, no DeepSeek key)');
    log.debug('calling DeepSeek (fallback)');
    result = await callDeepSeek(prompt, maxTokens);
    log.debug('DeepSeek fallback succeeded');
  }

  // Cache the result
  if (cache) {
    const key = generateCacheKey(cacheNs, prompt);
    setCachedResponse(key, result);
  }

  return result;
}

/**
 * Call Gemini with a structured response schema (type-enforced JSON output).
 * Used for the final extraction step.
 *
 * @param {string} prompt         Full prompt with prospectus text
 * @param {object} responseSchema JSON Schema object (from schema.js)
 * @param {object} [opts]
 * @param {boolean} [opts.cache=true]
 * @returns {Promise<object>}
 */
async function callGeminiStructured(prompt, responseSchema, opts = {}) {
  const { cache = true } = opts;

  if (cache) {
    const key = generateCacheKey('gemini_structured', prompt);
    const cached = getCachedResponse(key);
    if (cached) return cached;
  }

  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required for structured extraction');

  const client = getGenaiClient();
  const response = await client.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema,
    },
  });

  const text = response.text;
  if (!text) throw new Error('Gemini structured returned empty content');
  const result = JSON.parse(text);

  if (cache) {
    const key = generateCacheKey('gemini_structured', prompt);
    setCachedResponse(key, result);
  }

  return result;
}

module.exports = { callLlmJson, callGeminiStructured };
