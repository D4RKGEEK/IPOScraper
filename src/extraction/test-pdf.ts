import * as fs from 'fs';
import * as mupdf from 'mupdf';

async function run() {
  const res = await fetch('https://hemadmin.hemsecurities.com/images/Files/offer/1078.pdf');
  const buf = Buffer.from(await res.arrayBuffer());
  const doc = mupdf.Document.openDocument(buf, 'application/pdf');
  const page = doc.loadPage(2); // Page 3 (TABLE OF CONTENTS)
  
  const st = page.toStructuredText('preserve-whitespace');
  console.log(st.asJSON().substring(0, 2000));
}

run().catch(console.error);
