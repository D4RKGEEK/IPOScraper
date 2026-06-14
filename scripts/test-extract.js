'use strict';

(async () => {
  const slug = process.argv[2] || 'horizon-reclaim-india-ipo';
  const docType = process.argv[3] || 'auto';
  const pipeline = process.argv[4] || 'cascade';
  const force = process.argv[5] === 'true';

  const body = JSON.stringify({ pipeline, docType, force, wait: true });

  console.log(`Calling: POST /ipos/${slug}/extract`);
  console.log(`Body: ${body}`);

  const res = await fetch(`http://localhost:3001/ipos/${slug}/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(15 * 60 * 1000), // 15 min
  });
  console.log('Status:', res.status);
  const text = await res.text();
  console.log('Response length:', text.length);

  try {
    const data = JSON.parse(text);
    if (data.result) {
      const r = data.result;
      console.log('\n=== SECTIONS EXTRACTED ===');
      console.log('sections:', Object.keys(data.sections || {}));
      console.log('\n=== FINANCIALS ROWS ===');
      console.log('count:', r.financials?.length || 0);
      for (const row of (r.financials || [])) {
        console.log('  -', JSON.stringify(row));
      }
      console.log('\n=== KPIs ROWS ===');
      console.log('count:', r.kpis?.length || 0);
      for (const row of (r.kpis || []).slice(0, 6)) {
        console.log('  -', JSON.stringify(row));
      }
      console.log('\n=== VALIDATION ===');
      console.log('score:', data.validation?.score, '/ status:', data.validation?.status);
      if (data.validation?.failed) {
        console.log('failed rules:', data.validation.failed);
      }
    } else {
      console.log('No result in response. Keys:', Object.keys(data));
      if (data.error) console.log('Error:', data.error);
    }
  } catch (e) {
    console.log('Not JSON, last 3000 chars:');
    console.log(text.slice(-3000));
  }
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
