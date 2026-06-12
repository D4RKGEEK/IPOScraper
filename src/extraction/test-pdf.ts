import * as fs from 'fs';
import * as mupdf from 'mupdf';
import { pageText } from './pdf/mupdf-helpers.ts';

async function run() {
  console.log('Downloading PDF...');
  const res = await fetch('https://hemadmin.hemsecurities.com/images/Files/offer/1078.pdf');
  const buf = Buffer.from(await res.arrayBuffer());
  
  console.log('Opening PDF...');
  const doc = mupdf.Document.openDocument(buf, 'application/pdf');
  
  console.log('Page Count:', doc.countPages());
  
  for (let i = 0; i < Math.min(10, doc.countPages()); i++) {
    const text = pageText(doc, i);
    console.log(`\n--- PAGE ${i + 1} ---`);
    console.log(text.substring(0, 500));
  }
}

run().catch(console.error);
