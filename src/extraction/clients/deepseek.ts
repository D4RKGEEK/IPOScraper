/**
 * deepseek.ts — §11.5. Fallback brain + ToC locator. deepseek-chat, JSON mode,
 * temperature 0, fence-tolerant parsing.
 */
import { CFG } from '../config';
import { withRetry } from '../util/retry';

export async function deepseekJson(
  system: string,
  user: string,
  onTokens?: (tokens: number) => void,
): Promise<unknown> {
  return withRetry(async () => {
    const res = await fetch(`${CFG.deepseek.base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CFG.deepseek.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`deepseek ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { total_tokens?: number };
    };
    if (data.usage?.total_tokens) onTokens?.(data.usage.total_tokens);
    const raw = data.choices?.[0]?.message?.content ?? '{}';
    try {
      return JSON.parse(raw);
    } catch {
      return JSON.parse(raw.replace(/```json|```/g, '').trim()); // fence tolerance
    }
  }, 'deepseek-json');
}

export const EXTRACT_SYSTEM = (schemaText: string): string => `
You extract fields from Indian IPO documents (DRHP/RHP/Prospectus).
Return ONLY a JSON object matching this schema — no prose, no markdown fences:
${schemaText}
HARD RULES:
1. "evidence" must be a VERBATIM quote copied character-for-character from the provided text.
2. "page" must be the page number from the nearest "--- page N ---" marker above the evidence.
3. If a field is not present in the text, set its value to null. NEVER guess or infer.
4. Numbers: strip commas and currency symbols; "₹1,234.5 Cr" → 1234.5 with unit understood from the field description.
`;
