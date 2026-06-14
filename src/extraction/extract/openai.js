'use strict';

/**
 * openai.js — Phase 3A: OpenAI structured extraction.
 *
 * Merges all section .md files into one big text, sends to OpenAI
 * with the IPODetails schema for type-enforced structured output.
 */

const fs = require('fs');
const path = require('path');
const { callOpenAIStructured } = require('../llm/openai');
const { getGeminiSchema } = require('../llm/schema');
const { logger } = require('../../utils/logger');

const log = logger.child({ module: 'extraction:openai' });

/**
 * Run OpenAI structured extraction on the extracted section markdown files.
 *
 * @param {string} outputDir   e.g. 'data/output/hexagon-nutrition-ipo'
 * @param {string[]} sections  Section names with .md files in outputDir
 * @returns {Promise<object>}  Structured IPODetails JSON
 */
async function runOpenAIExtraction(outputDir, sections) {
    // Merge all section markdown into one big text
    const mergedParts = [];
    for (const section of sections) {
        const mdPath = path.join(outputDir, `${section}.md`);
        if (!fs.existsSync(mdPath)) {
            log.warn({ section, mdPath }, 'section markdown not found, skipping');
            continue;
        }
        const content = fs.readFileSync(mdPath, 'utf8');
        mergedParts.push(`# SECTION: ${section}\n\n${content}\n`);
    }

    const mergedText = mergedParts.join('\n\n');

    // Save merged file for debugging
    const mergedPath = path.join(outputDir, 'merged_openai.md');
    fs.writeFileSync(mergedPath, mergedText, 'utf8');
    log.debug({ mergedPath, chars: mergedText.length }, 'merged markdown saved');

    const prompt = `You are an expert financial analyst specializing in Indian IPOs.
Extract all available structured information from the following DRHP/RHP prospectus text.
For any fields not found in the text, return null.
Be precise with numbers, dates, and financial figures. Preserve original units (Crore, Lakhs, etc.).

PROSPECTUS TEXT:
${mergedText}`;

    log.info({ sections: sections.length, chars: mergedText.length }, 'calling OpenAI structured extraction');

    const result = await callOpenAIStructured(prompt, getGeminiSchema());

    // Save result
    const resultPath = path.join(outputDir, 'summary_openai.json');
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
    log.info({ resultPath }, 'OpenAI extraction complete');

    return result;
}

module.exports = { runOpenAIExtraction };