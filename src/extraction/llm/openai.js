'use strict';

/**
 * openai.js — OpenAI client abstraction for extraction pipeline.
 *
 * callOpenAIStructured(prompt, schema) — OpenAI with JSON schema for structured extraction.
 * callOpenAIFreeform(prompt)           — OpenAI freeform JSON tasks.
 *
 * Uses raw fetch() with OpenAI-compatible API format.
 */

const { env } = require('../config');
const { generateCacheKey, getCachedResponse, setCachedResponse } = require('../cache');
const { recordOpenAIUsage } = require('../usage');
const { logger } = require('../../utils/logger');

const log = logger.child({ module: 'extraction:openai' });

// ── OpenAI Client ─────────────────────────────────────────────────────────────

/**
 * Call OpenAI with a structured response schema (type-enforced JSON output).
 * Used for the final extraction step.
 *
 * @param {string} prompt         Full prompt with prospectus text
 * @param {object} responseSchema JSON Schema object (from schema.js)
 * @param {object} [opts]
 * @param {string} [opts.model]   Model to use (default: OPENAI_MODEL env var)
 * @param {boolean} [opts.cache=true]
 * @returns {Promise<object>}
 */
async function callOpenAIStructured(prompt, responseSchema, opts = {}) {
    const { model = env.OPENAI_MODEL, cache = true } = opts;

    if (!model) {
        throw new Error('OPENAI_MODEL is required (e.g., "gpt-4o-mini")');
    }

    if (cache) {
        const key = generateCacheKey('openai_structured', `${model}:${prompt}`);
        const cached = await getCachedResponse(key);
        if (cached) return cached;
    }

    if (!env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY is required for structured extraction');
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
            parallel_tool_calls: false,
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

    let result;
    try {
        result = JSON.parse(text);
    } catch (parseErr) {
        // Try to extract JSON from markdown fences
        const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
            result = JSON.parse(jsonMatch[1].trim());
        } else {
            result = JSON.parse(text.replace(/```|```json/g, '').trim());
        }
    }

    if (cache) {
        const key = generateCacheKey('openai_structured', `${model}:${prompt}`);
        await setCachedResponse(key, result);
    }

    return result;
}

/**
 * Call OpenAI for a JSON task. General purpose.
 *
 * @param {string} prompt     The full prompt
 * @param {object} [opts]
 * @param {number} [opts.maxTokens=2000]
 * @param {string} [opts.model]   Model to use (default: OPENAI_MODEL env var)
 * @param {boolean} [opts.cache=true]   Whether to use disk cache
 * @param {string} [opts.cacheNs='openai'] Cache namespace
 * @returns {Promise<object>}  Parsed JSON response
 */
async function callOpenAIFreeform(prompt, opts = {}) {
    const { maxTokens = 2000, model = env.OPENAI_MODEL, cache = true, cacheNs = 'openai' } = opts;

    if (!model) {
        throw new Error('OPENAI_MODEL is required (e.g., "gpt-4o-mini")');
    }

    // Check cache first
    if (cache) {
        const key = generateCacheKey(cacheNs, prompt);
        const cached = await getCachedResponse(key);
        if (cached) return cached;
    }

    if (!env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY is required for OpenAI calls');
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

    let result;
    try {
        result = JSON.parse(text);
    } catch (parseErr) {
        // Try to extract JSON from markdown fences
        const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
            result = JSON.parse(jsonMatch[1].trim());
        } else {
            result = JSON.parse(text.replace(/```|```json/g, '').trim());
        }
    }

    // Cache the result
    if (cache) {
        const key = generateCacheKey(cacheNs, prompt);
        await setCachedResponse(key, result);
    }

    return result;
}

module.exports = { callOpenAIStructured, callOpenAIFreeform };