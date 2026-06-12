const axios = require('axios');

const TELEGRAM_API = 'https://api.telegram.org';

/**
 * Send a message to a Telegram chat.
 * @param {string} text       - Message text (supports HTML parse mode)
 * @param {object} [options]
 * @param {string} [options.botToken]  - Bot token (falls back to TELEGRAM_BOT_TOKEN env)
 * @param {string} [options.chatId]    - Chat ID (falls back to TELEGRAM_CHAT_ID env)
 * @param {string} [options.parseMode] - 'HTML' or 'Markdown' (default: 'HTML')
 * @returns {Promise<void>}
 */
async function sendTelegram(text, options = {}) {
  const botToken = options.botToken || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = options.chatId || process.env.TELEGRAM_CHAT_ID;
  const parseMode = options.parseMode || 'HTML';

  if (!botToken) throw new Error('sendTelegram: TELEGRAM_BOT_TOKEN is required');
  if (!chatId) throw new Error('sendTelegram: TELEGRAM_CHAT_ID is required');

  await axios.post(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: parseMode,
    disable_web_page_preview: true,
  }, { timeout: 10000 });
}

/**
 * Build a summary message from pipeline run statistics.
 * @param {object} stats
 * @param {number} stats.total       - Total IPOs in master list
 * @param {number} stats.newRecords  - Newly added records
 * @param {number} stats.updated     - Updated records
 * @param {number} stats.borderline  - Borderline/review-flagged records
 * @param {number} [stats.gmpUpdated]    - GMP records updated
 * @param {number} [stats.candlesUpdated] - Candle records updated
 * @param {string} [stats.date]      - Run date (defaults to today)
 * @returns {string} Formatted HTML message
 */
function buildSummaryMessage(stats) {
  const date = stats.date || new Date().toISOString().split('T')[0];

  const lines = [
    `📊 <b>IPO Pipeline Update</b> — ${date}`,
    '',
    `📋 Master list: <b>${stats.total}</b> IPOs`,
    `🆕 New records: <b>${stats.newRecords ?? 0}</b>`,
    `🔄 Updated: <b>${stats.updated ?? 0}</b>`,
    `⚠️ Borderline: <b>${stats.borderline ?? 0}</b>`,
  ];

  if (stats.gmpUpdated != null) {
    lines.push(`📈 GMP updated: <b>${stats.gmpUpdated}</b>`);
  }
  if (stats.candlesUpdated != null) {
    lines.push(`🕯️ Candles updated: <b>${stats.candlesUpdated}</b>`);
  }

  lines.push('', '✅ Pipeline completed successfully');

  return lines.join('\n');
}

/**
 * Send a pipeline completion summary to Telegram.
 * @param {object} stats - Run statistics (see buildSummaryMessage)
 * @param {object} [options] - Bot token / chat ID overrides
 * @returns {Promise<void>}
 */
async function notifyPipelineComplete(stats, options = {}) {
  const message = buildSummaryMessage(stats);
  await sendTelegram(message, options);
}

/**
 * Send a pipeline failure alert to Telegram.
 * @param {Error|string} error  - The error that caused the failure
 * @param {object} [options]    - Bot token / chat ID overrides
 * @returns {Promise<void>}
 */
async function notifyPipelineError(error, options = {}) {
  const errorMsg = error instanceof Error ? error.message : String(error);
  const date = new Date().toISOString().split('T')[0];

  const message = [
    `❌ <b>IPO Pipeline FAILED</b> — ${date}`,
    '',
    `<code>${errorMsg.slice(0, 500)}</code>`,
  ].join('\n');

  await sendTelegram(message, options);
}

module.exports = {
  sendTelegram,
  buildSummaryMessage,
  notifyPipelineComplete,
  notifyPipelineError,
};
