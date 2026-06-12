'use strict';

/**
 * jobRepository.js — background job tracking (scrape, gmp, historical, documents).
 * A job: { _id, type, status: running|completed|failed, params, result, error, createdAt, finishedAt }.
 */

const { collections } = require('./mongo');

const { ObjectId } = require('mongodb');
const oid = (id) => { try { return new ObjectId(id); } catch { return null; } };

async function createJob(type, params = {}) {
  const now = new Date().toISOString();
  const res = await collections.jobs().insertOne({ type, status: 'running', params, logs: [], result: null, error: null, createdAt: now, finishedAt: null, durationMs: null });
  return res.insertedId.toString();
}

/** Append a timestamped milestone log line to a job (best-effort, non-blocking). */
function appendLog(id, msg) {
  const _id = oid(id);
  if (!_id) return Promise.resolve();
  return collections.jobs().updateOne({ _id }, { $push: { logs: { at: new Date().toISOString(), msg: String(msg) } } }).catch(() => {});
}

async function completeJob(id, result, durationMs = null) {
  await collections.jobs().updateOne({ _id: oid(id) }, { $set: { status: 'completed', result, finishedAt: new Date().toISOString(), durationMs } });
}

async function failJob(id, error, durationMs = null) {
  await collections.jobs().updateOne({ _id: oid(id) }, { $set: { status: 'failed', error: String(error), finishedAt: new Date().toISOString(), durationMs } });
}

async function getJob(id) {
  const _id = oid(id);
  if (!_id) return null;
  const job = await collections.jobs().findOne({ _id });
  if (!job) return null;
  return { jobId: job._id.toString(), ...job, _id: undefined };
}

async function listJobs({ type, status, limit = 20 } = {}) {
  const filter = {};
  if (type) filter.type = type;
  if (status) filter.status = status;
  const jobs = await collections.jobs().find(filter).sort({ createdAt: -1 }).limit(Math.min(100, limit)).toArray();
  return jobs.map((j) => ({ jobId: j._id.toString(), type: j.type, status: j.status, createdAt: j.createdAt, finishedAt: j.finishedAt, durationMs: j.durationMs, result: j.result, error: j.error }));
}

module.exports = { createJob, appendLog, completeJob, failJob, getJob, listJobs };
