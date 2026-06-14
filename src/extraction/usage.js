'use strict';

/**
 * usage.js — API usage tracker for the extraction pipeline.
 *
 * Accumulates token usage (Gemini, DeepSeek) and credits used (Firecrawl)
 * across all API calls within a single extraction run.
 *
 * Usage is reset at the start of each runExtraction / runBulkExtraction call.
 */

const _state = {
  llm: {
    gemini: { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 },
    deepseek: { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 },
    openai: { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0, cost: 0 }
  },
  firecrawl: { creditsUsed: 0, calls: 0 },
};

function resetUsage() {
  _state.llm.gemini = { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
  _state.llm.deepseek = { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
  _state.llm.openai = { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0, cost: 0 };
  _state.firecrawl = { creditsUsed: 0, calls: 0 };
}

function getUsage() {
  return {
    llm: {
      gemini: { ..._state.llm.gemini },
      deepseek: { ..._state.llm.deepseek },
      openai: { ..._state.llm.openai },
    },
    firecrawl: { ..._state.firecrawl },
  };
}

function recordGeminiUsage(usageMetadata) {
  if (!usageMetadata) return;
  _state.llm.gemini.promptTokens += usageMetadata.promptTokenCount || 0;
  _state.llm.gemini.completionTokens += usageMetadata.candidatesTokenCount || 0;
  _state.llm.gemini.totalTokens += usageMetadata.totalTokenCount || 0;
  _state.llm.gemini.calls++;
}

function recordDeepSeekUsage(usage) {
  if (!usage) return;
  _state.llm.deepseek.promptTokens += usage.prompt_tokens || 0;
  _state.llm.deepseek.completionTokens += usage.completion_tokens || 0;
  _state.llm.deepseek.totalTokens += usage.total_tokens || 0;
  _state.llm.deepseek.calls++;
}

/**
 * Record OpenAI API usage.
 * @param {object} usage OpenAI usage object (prompt_tokens, completion_tokens, total_tokens)
 * @param {string} [model] Model name (for cost estimation)
 */
function recordOpenAIUsage(usage, model) {
  if (!usage) return;
  _state.llm.openai.promptTokens += usage.prompt_tokens || 0;
  _state.llm.openai.completionTokens += usage.completion_tokens || 0;
  _state.llm.openai.totalTokens += usage.total_tokens || 0;
  _state.llm.openai.calls++;

  // Rough cost estimation based on model (USD per 1M tokens)
  let costPer1M = 0.15; // default to gpt-4o-mini
  if (model) {
    if (model.includes('gpt-4o')) costPer1M = 2.50;  // gpt-4o: $2.50/$12.50
    else if (model.includes('gpt-4o-mini')) costPer1M = 0.15;  // gpt-4o-mini: $0.15/$0.60
    else if (model.includes('gpt-4')) costPer1M = 3.00;  // gpt-4: $3.00/$9.00
    else if (model.includes('o1')) costPer1M = 15.00;  // o1: $15.00/$60.00
  }
  _state.llm.openai.cost += (usage.total_tokens / 1_000_000) * costPer1M;
}

function recordFirecrawlUsage(creditsUsed) {
  _state.firecrawl.creditsUsed += typeof creditsUsed === 'number' ? creditsUsed : 0;
  _state.firecrawl.calls++;
}

module.exports = { resetUsage, getUsage, recordGeminiUsage, recordDeepSeekUsage, recordOpenAIUsage, recordFirecrawlUsage };
