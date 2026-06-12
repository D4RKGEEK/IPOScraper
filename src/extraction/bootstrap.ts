/**
 * bootstrap.ts — wires the extraction pipeline into the main Express process:
 * connects the extraction Mongo DB, creates the R2 client, starts the queue
 * worker, and returns the /v1 router for server.js to mount. One process,
 * one port, one command.
 */
import type { Router } from 'express';
import { connectExtractionDb } from './db';
import { createR2 } from './r2';
import { buildExtractionRouter } from './api';
import { startWorkerLoop } from './worker';

export async function createExtraction(): Promise<{ router: Router }> {
  const db = await connectExtractionDb();
  const r2 = createR2();
  void startWorkerLoop(db, r2); // fire-and-forget; loop never resolves
  return { router: buildExtractionRouter(db, r2) };
}
