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
const { recordGeminiUsage, recordDeepSeekUsage, recordOpenAIUsage } = require('../usage');
const { logger } = require('../../utils/logger');

const log = logger.child({ module: 'extraction:llm' });

// ── OpenAI Client ─────────────────────────────────────────────────────────────

async function callOpenAI(prompt, maxTokens = 2000, model = env.OPENAI_MODEL) {
  if (!model) {
    throw new Error('OPENAI_MODEL is required (e.g., "gpt-4o-mini")');
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: model,
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
    throw new Error(`OpenAI API ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI returned empty content');
  recordOpenAIUsage(data.usage, data.model);
  return JSON.parse(text);
}

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
  recordDeepSeekUsage(data.usage);
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
  recordGeminiUsage(response.usageMetadata);
  return JSON.parse(text);
}

/**
 * Call an LLM for a JSON task with configurable cascade order.
 * Default cascade: Gemini → OpenAI → DeepSeek
 * Can be overridden via OPENAI_MODEL env var.
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
    const cached = await getCachedResponse(key);
    if (cached) return cached;
  }

  let result;
  const fallbacks = [];

  // Build fallback chain: always try Gemini first, then optionally OpenAI, then DeepSeek
  if (env.GEMINI_API_KEY) fallbacks.push({ name: 'Gemini', fn: callGeminiFreeform });
  if (env.OPENAI_API_KEY && env.OPENAI_MODEL) fallbacks.push({ name: 'OpenAI', fn: callOpenAI });
  if (env.DEEPSEEK_API_KEY) fallbacks.push({ name: 'DeepSeek', fn: callDeepSeek });

  if (fallbacks.length === 0) {
    throw new Error('No LLM API keys configured (GEMINI_API_KEY, OPENAI_API_KEY, or DEEPSEEK_API_KEY)');
  }

  // Try each fallback in order
  for (const { name, fn } of fallbacks) {
    try {
      log.debug(`calling ${name}`);
      result = await fn(prompt, maxTokens);
      log.debug(`${name} succeeded`);
      break;
    } catch (e) {
      log.warn({ err: e.message, engine: name }, `${name} failed`);
    }
  }

  // Guard against a model returning a literal `null`/non-object JSON
  if (result === null || typeof result !== 'object') {
    throw new Error(`LLM returned non-object JSON (${result === null ? 'null' : typeof result})`);
  }

  // Cache the result
  if (cache) {
    const key = generateCacheKey(cacheNs, prompt);
    await setCachedResponse(key, result);
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
    const cached = await getCachedResponse(key);
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
  recordGeminiUsage(response.usageMetadata);

  if (cache) {
    const key = generateCacheKey('gemini_structured', prompt);
    await setCachedResponse(key, result);
  }

  return result;
}

module.exports = { callLlmJson, callGeminiStructured };
