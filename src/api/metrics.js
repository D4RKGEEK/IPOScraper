'use strict';

/**
 * metrics.js — point-in-time system metrics for the host running this process.
 *
 * Reports whichever machine the API is on: run it locally and you see your
 * box; open the deployed dashboard and you see the server. Backed by
 * `systeminformation` so CPU%, disk usage, and network throughput work the
 * same on macOS and Linux without shelling out by hand.
 *
 * Network throughput (rx/tx per second) is a delta: systeminformation computes
 * it from the bytes seen since the previous networkStats() call. The first call
 * after boot has no baseline and returns -1, so we prime it on startup and clamp
 * negatives to 0 in the payload.
 */

const os = require('os');
const si = require('systeminformation');

// Prime the network counter so the first real request gets a sane rx/tx delta
// instead of the -1 systeminformation returns when it has no prior sample.
si.networkStats().catch(() => {});

const num = (v, fb = 0) => (Number.isFinite(v) ? v : fb);
const pct = (used, total) => (total > 0 ? Math.round((used / total) * 1000) / 10 : 0);

/**
 * Collect a snapshot of host metrics. Each probe is independent and falls back
 * to a zeroed shape on failure, so one slow/unsupported probe never fails the
 * whole response (mirrors the resilient `safe()` pattern in /stats).
 */
async function collectSystemMetrics() {
  const safe = async (p, fb) => { try { return await p; } catch { return fb; } };

  const [load, mem, fs, net] = await Promise.all([
    safe(si.currentLoad(), null),
    safe(si.mem(), null),
    safe(si.fsSize(), []),
    safe(si.networkStats(), []),
  ]);

  // Disk: prefer the root filesystem; otherwise the largest real mount.
  const realFs = (fs || []).filter((d) => num(d.size) > 0);
  const disk = realFs.find((d) => d.mount === '/' || d.mount === 'C:\\')
    || realFs.sort((a, b) => b.size - a.size)[0]
    || null;

  // Network: sum across the active interfaces so a multi-NIC box isn't
  // under-reported. networkStats() returns per-iface rows.
  const rx = (net || []).reduce((s, n) => s + Math.max(0, num(n.rx_sec)), 0);
  const tx = (net || []).reduce((s, n) => s + Math.max(0, num(n.tx_sec)), 0);

  const totalMem = mem ? num(mem.total) : num(os.totalmem());
  const usedMem = mem ? num(mem.active, num(mem.total) - num(mem.available)) : num(os.totalmem()) - num(os.freemem());

  return {
    at: new Date().toISOString(),
    host: {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      uptimeSec: Math.round(os.uptime()),
    },
    cpu: {
      loadPct: load ? Math.round(num(load.currentLoad) * 10) / 10 : 0,
      cores: os.cpus()?.length || 0,
    },
    memory: {
      usedBytes: usedMem,
      totalBytes: totalMem,
      usedPct: pct(usedMem, totalMem),
    },
    disk: disk
      ? { usedBytes: num(disk.used), totalBytes: num(disk.size), usedPct: pct(num(disk.used), num(disk.size)), mount: disk.mount }
      : { usedBytes: 0, totalBytes: 0, usedPct: 0, mount: null },
    network: { rxBytesSec: Math.round(rx), txBytesSec: Math.round(tx) },
    process: { rssBytes: process.memoryUsage().rss },
  };
}

module.exports = { collectSystemMetrics };
