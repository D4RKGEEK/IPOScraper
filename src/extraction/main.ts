/**
 * main.ts — entrypoint (PRD §11.10): API server and queue worker in ONE process
 * (a 500 MB box doesn't want two). Run with: npm run extraction
 */
import { CFG } from './config';
import { connectExtractionDb } from './db';
import { createR2 } from './r2';
import { buildApi } from './api';
import { startWorkerLoop } from './worker';

async function main(): Promise<void> {
  const db = await connectExtractionDb();
  const r2 = createR2();
  const app = buildApi(db, r2);
  await app.listen({ port: CFG.port, host: '0.0.0.0' });
  console.log(`[extraction] API listening on :${CFG.port} — worker loop starting`);
  await startWorkerLoop(db, r2); // never returns
}

main().catch((e) => {
  console.error('[extraction] fatal:', e);
  process.exit(1);
});
