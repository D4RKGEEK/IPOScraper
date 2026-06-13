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
  llm: { gemini: { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 },
         deepseek: { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 } },
  firecrawl: { creditsUsed: 0, calls: 0 },
};

function resetUsage() {
  _state.llm.gemini = { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
  _state.llm.deepseek = { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
  _state.firecrawl = { creditsUsed: 0, calls: 0 };
}

function getUsage() {
  return {
    llm: {
      gemini: { ..._state.llm.gemini },
      deepseek: { ..._state.llm.deepseek },
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

function recordFirecrawlUsage(creditsUsed) {
  _state.firecrawl.creditsUsed += typeof creditsUsed === 'number' ? creditsUsed : 0;
  _state.firecrawl.calls++;
}

module.exports = { resetUsage, getUsage, recordGeminiUsage, recordDeepSeekUsage, recordFirecrawlUsage };
