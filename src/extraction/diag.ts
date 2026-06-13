import * as fs from 'node:fs';
import { openDoc } from './pdf/mupdf-helpers';
import { sectionToHtml } from './pdf/to-markdown';
import { FIELDS, schemaFor } from './registry/fields';
import { parseHtmlJson } from './clients/firecrawl';
(async () => {
  const doc = openDoc(fs.readFileSync('/tmp/rhp.pdf'));
  for (const section of ['offer_structure', 'financials', 'basis_for_price']) {
    const defs = FIELDS.filter((f) => f.section === section);
    const schemaStr = JSON.stringify(schemaFor(defs));
    console.log(`\n[${section}] ${defs.length} fields, schema ${schemaStr.length} chars, $ref=${schemaStr.includes('$ref')}`);
  }
  // Hit Firecrawl once with the big offer_structure schema on the cover.
  const offer = FIELDS.filter((f) => f.section === 'offer_structure');
  const { html } = sectionToHtml(doc, 0, 2);
  const r = await parseHtmlJson(html, 'diag', schemaFor(offer));
  console.log('\n=== offer_structure (20 fields) cover-pass jsonReturned=', !!r.json, '===');
  if (r.json) console.log('keys:', Object.keys(r.json).length, '| values:',
    Object.fromEntries(Object.entries(r.json).map(([k, v]: any) => [k, v?.value])));
  doc.destroy();
})().catch((e) => { console.error('ERR', e); process.exit(1); });
