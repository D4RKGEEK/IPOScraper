import { describe, it, expect } from 'vitest';
import { buildSchemaProposal, buildValidationProposal } from '../../src/extraction/ai-edit.js';

// These exercise the SAFETY GATE + diff/warnings directly on a simulated model
// response — no LLM, no mocking. (aiEditSchema/aiEditValidation are a thin LLM
// call that feeds these pure builders.)

describe('ai-edit: buildSchemaProposal', () => {
  const current = { company_name: { type: 'string', description: 'name' } };

  it('returns a validated proposal + diff for well-formed model output', () => {
    const out = buildSchemaProposal({
      explanation: 'Added a GST number field.',
      fields: {
        company_name: { type: 'string', description: 'name' },
        gst_number: { type: 'string', description: 'Company GST number' },
      },
    }, current);
    expect(out.proposed.gst_number.type).toBe('string');
    expect(out.diff.added).toContain('gst_number');
    expect(out.explanation).toMatch(/GST/i);
  });

  it('REJECTS structurally invalid model output and never returns a proposal', () => {
    expect(() => buildSchemaProposal({ fields: { 'Bad Key': { type: 'banana' } } }, current))
      .toThrow(/failed validation/);
  });

  it('tags the rejection with status 422 and the raw model output', () => {
    const raw = { fields: { x: { type: 'nope' } } };
    try {
      buildSchemaProposal(raw, current);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.status).toBe(422);
      expect(e.raw).toBe(raw);
    }
  });
});

describe('ai-edit: buildValidationProposal', () => {
  const current = [
    { id: 'risk_factors_present', field: 'risk_factors', type: 'min_items', severity: 'warning', weight: 5, params: { min: 3 } },
  ];

  it('returns a validated ruleset + threshold + soft warnings', () => {
    const out = buildValidationProposal({
      explanation: 'Stricter risk factors.',
      threshold: 85,
      rules: [
        { id: 'risk_factors_present', field: 'risk_factors', type: 'min_items', severity: 'error', weight: 8, params: { min: 5 } },
        { id: 'orphan_rule', field: 'not_a_real_field', type: 'required', severity: 'warning', weight: 3 },
      ],
    }, current, 80, ['risk_factors']);
    expect(out.threshold).toBe(85);
    expect(out.proposed.find((r) => r.id === 'risk_factors_present').params.min).toBe(5);
    // orphan_rule targets a field not in the schema → soft warning, not a block.
    expect(out.warnings.some((w) => w.includes('orphan_rule'))).toBe(true);
    expect(out.diff.added).toContain('orphan_rule');
  });

  it('keeps the current threshold when the model omits or out-of-ranges it', () => {
    const out = buildValidationProposal({ rules: current, threshold: 999 }, current, 80, ['risk_factors']);
    expect(out.threshold).toBe(80);
  });

  it('REJECTS a ruleset with a duplicate id (status 422)', () => {
    try {
      buildValidationProposal({
        rules: [
          { id: 'dup', field: 'a', type: 'required', severity: 'error', weight: 1 },
          { id: 'dup', field: 'b', type: 'required', severity: 'error', weight: 1 },
        ],
      }, current, 80, []);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.status).toBe(422);
    }
  });
});
