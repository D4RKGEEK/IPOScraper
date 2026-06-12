import { test, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const { buildSummaryMessage, sendTelegram, notifyPipelineError } = require('../utils/telegramNotifier.js');

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── buildSummaryMessage ───────────────────────────────────────────────────────

test('buildSummaryMessage includes key stats', () => {
  const msg = buildSummaryMessage({
    total: 98,
    newRecords: 3,
    updated: 7,
    borderline: 12,
    gmpUpdated: 45,
    candlesUpdated: 22,
    date: '2026-06-07',
  });

  expect(msg).toContain('2026-06-07');
  expect(msg).toContain('98');
  expect(msg).toContain('3');
  expect(msg).toContain('7');
  expect(msg).toContain('12');
  expect(msg).toContain('45');
  expect(msg).toContain('22');
  expect(msg).toContain('Pipeline completed successfully');
});

test('buildSummaryMessage omits gmp/candle lines when not provided', () => {
  const msg = buildSummaryMessage({ total: 50, newRecords: 0, updated: 0, borderline: 0 });
  expect(msg).not.toContain('GMP updated');
  expect(msg).not.toContain('Candles updated');
});

// ─── sendTelegram ─────────────────────────────────────────────────────────────

test('sendTelegram throws when botToken is missing', async () => {
  await expect(
    sendTelegram('hello', { botToken: '', chatId: '123' })
  ).rejects.toThrow(/TELEGRAM_BOT_TOKEN/);
});

test('sendTelegram throws when chatId is missing', async () => {
  await expect(
    sendTelegram('hello', { botToken: 'token', chatId: '' })
  ).rejects.toThrow(/TELEGRAM_CHAT_ID/);
});

test('sendTelegram calls Telegram API with correct payload', async () => {
  const axios = require('axios');
  const spy = vi.spyOn(axios, 'post').mockResolvedValue({ data: { ok: true } });

  await sendTelegram('Test message', { botToken: 'mytoken', chatId: '12345' });

  expect(spy).toHaveBeenCalledOnce();
  const [url, payload] = spy.mock.calls[0];
  expect(url).toContain('mytoken');
  expect(url).toContain('sendMessage');
  expect(payload.chat_id).toBe('12345');
  expect(payload.text).toBe('Test message');
});

// ─── notifyPipelineError ──────────────────────────────────────────────────────

test('notifyPipelineError sends error message with failure marker', async () => {
  const axios = require('axios');
  const spy = vi.spyOn(axios, 'post').mockResolvedValue({ data: { ok: true } });

  await notifyPipelineError(new Error('Connection refused'), {
    botToken: 'tok',
    chatId: '999',
  });

  expect(spy).toHaveBeenCalledOnce();
  const [, payload] = spy.mock.calls[0];
  expect(payload.text).toContain('FAILED');
  expect(payload.text).toContain('Connection refused');
});
