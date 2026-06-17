// TEMP instrumentation to pin the intermittent beeperbox `tools/call: timeout
// after 15000ms`. Root CLASS is proven (event loop blocked >=15s aborts an
// in-flight MCP call); this finds the SECOND blocking site. Stdlib only.
//
// Two signals, interleaved on stdout so they can be read together:
//   [INSTR ts] <label>            phase marks (with +Nms since a per-op clock)
//   [INSTR ts] !! event-loop blocked ~Nms   the loop stalled between ticks
//
// On by default; disable with MULTIS_INSTR=0. DELETE this file + its callers
// once the root cause is named.
const { performance } = require('node:perf_hooks');

const ENABLED = process.env.MULTIS_INSTR !== '0';

function now() { return performance.now(); }
function ts() { return new Date().toISOString().slice(11, 23); }

/** Phase mark. Pass the clock from startClock() to get elapsed-since-op. */
function mark(label, t0) {
  if (!ENABLED) return;
  const rel = t0 != null ? ` +${(now() - t0).toFixed(0)}ms` : '';
  console.log(`[INSTR ${ts()}]${rel} ${label}`);
}

/** High-res start point for relative timing. */
function startClock() { return now(); }

// Event-loop lag monitor. A timer asked to fire every TICK_MS; if the real gap
// exceeds TICK_MS + threshold, the loop was blocked synchronously in between —
// which is exactly what aborts the beeperbox call.
const TICK_MS = 100;
const LAG_THRESHOLD_MS = 150;
let lagTimer = null;
let lastTick = 0;

function startLagMonitor() {
  if (!ENABLED || lagTimer) return;
  lastTick = now();
  lagTimer = setInterval(() => {
    const t = now();
    const lag = t - lastTick - TICK_MS;
    lastTick = t;
    if (lag > LAG_THRESHOLD_MS) {
      console.log(`[INSTR ${ts()}] !! event-loop blocked ~${lag.toFixed(0)}ms`);
    }
  }, TICK_MS);
  if (lagTimer.unref) lagTimer.unref();
}

module.exports = { mark, startClock, startLagMonitor, ENABLED };
