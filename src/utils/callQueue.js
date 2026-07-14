const config = require('../config');
const { DateTime } = require('luxon');

const state = {
  pending: [],
  inFlightCalls: new Map(),
  lastDispatchAt: 0,
  lastFinishedAt: 0,
  dailyCount: 0,
  dailyDate: null,
  processing: false,
};

const MAX_CALL_DURATION_MS = 5 * 60 * 1000;

function currentDateAEST() {
  return DateTime.now().setZone(config.calling.timezoneDefault).toFormat('yyyy-LL-dd');
}

function rollDailyIfNeeded() {
  const today = currentDateAEST();
  if (state.dailyDate !== today) {
    state.dailyDate = today;
    state.dailyCount = 0;
  }
}

async function processNext() {
  if (state.processing) return;
  state.processing = true;

  try {
    while (state.pending.length > 0) {
      rollDailyIfNeeded();

      if (state.dailyCount >= config.calling.dailyLimit) {
        console.log(`\n🛑 [queue] DAILY CAP REACHED (${state.dailyCount}/${config.calling.dailyLimit}). Dropping ${state.pending.length} remaining call(s) for today.\n`);
        state.pending = [];
        break;
      }

      if (state.inFlightCalls.size >= config.calling.maxConcurrent) {
        const labels = Array.from(state.inFlightCalls.values()).map(c => c.contactId).join(', ');
        console.log(`⏸️  [queue] Already ${state.inFlightCalls.size} call(s) live (${labels}). Waiting for it to finish before next.`);
        break;
      }

      const sinceLastFinished = state.lastFinishedAt > 0
        ? (Date.now() - state.lastFinishedAt) / 1000
        : Infinity;
      const waitNeeded = state.lastFinishedAt > 0
        ? config.calling.spacingSeconds - sinceLastFinished
        : 0;
      if (waitNeeded > 0) {
        console.log(`⏱️  [queue] Waiting ${Math.ceil(waitNeeded)}s before next call (spacing between calls)...`);
        await new Promise(r => setTimeout(r, waitNeeded * 1000));
      }

      const job = state.pending.shift();
      state.lastDispatchAt = Date.now();
      state.dailyCount++;

      console.log(`\n📞 [queue] STARTING CALL ${state.dailyCount}/${config.calling.dailyLimit} for ${job.contactId} | ${state.pending.length} more in queue\n`);

      let vapiCallId = null;
      try {
        const result = await job.task();
        vapiCallId = result?.callId || null;
      } catch (err) {
        console.error(`❌ [queue] failed to start call for ${job.contactId}:`, err.response?.data || err.message);
        state.lastFinishedAt = Date.now();
        continue;
      }

      if (!vapiCallId) {
        console.warn(`⚠️  [queue] call for ${job.contactId} did not return a callId — treating as finished.`);
        state.lastFinishedAt = Date.now();
        continue;
      }

      const entry = {
        contactId: job.contactId,
        callId: vapiCallId,
        startedAt: Date.now(),
      };
      entry.timeout = setTimeout(() => {
        if (state.inFlightCalls.has(vapiCallId)) {
          console.warn(`⚠️  [queue] call ${vapiCallId} for ${entry.contactId} exceeded ${MAX_CALL_DURATION_MS/1000}s — releasing slot.`);
          markCallFinished(vapiCallId, 'timeout');
        }
      }, MAX_CALL_DURATION_MS);
      state.inFlightCalls.set(vapiCallId, entry);
      console.log(`📲 [queue] Call ${vapiCallId} for ${job.contactId} is now live. Holding queue until call ends.`);
    }
  } finally {
    state.processing = false;
  }
}

function markCallFinished(callId, reason = 'ended') {
  const entry = state.inFlightCalls.get(callId);
  if (!entry) return false;
  clearTimeout(entry.timeout);
  state.inFlightCalls.delete(callId);
  state.lastFinishedAt = Date.now();
  if (state.pending.length > 0) {
    console.log(`\n✅ [queue] CALL FINISHED (${reason}) for ${entry.contactId} | ${state.pending.length} call(s) still queued | next call in ${config.calling.spacingSeconds}s\n`);
  } else {
    console.log(`\n✅ [queue] CALL FINISHED (${reason}) for ${entry.contactId} | queue empty, no more calls pending\n`);
  }
  setImmediate(processNext);
  return true;
}

function enqueue(contactId, task) {
  state.pending.push({ contactId, task });
  const position = state.pending.length;
  if (state.inFlightCalls.size > 0) {
    const live = Array.from(state.inFlightCalls.values()).map(c => c.contactId).join(', ');
    console.log(`📥 [queue] Added ${contactId} to queue (position ${position}). Currently calling ${live} — will start after that ends.`);
  } else {
    console.log(`📥 [queue] Added ${contactId} to queue (position ${position}). Will start shortly.`);
  }
  setImmediate(processNext);
}

function enqueueFront(contactId, task) {
  state.pending.unshift({ contactId, task });
  const live = Array.from(state.inFlightCalls.values()).map(c => c.contactId).join(', ');
  console.log(`⚡ [queue] Priority retry for ${contactId} — pushed to front of queue (${state.pending.length} total).${live ? ` Currently calling ${live}.` : ''}`);
  setImmediate(processNext);
}

function getStatus() {
  rollDailyIfNeeded();
  return {
    pending: state.pending.length,
    inFlight: state.inFlightCalls.size,
    live: Array.from(state.inFlightCalls.values()).map(c => ({ contactId: c.contactId, callId: c.callId })),
    dailyCount: state.dailyCount,
    dailyLimit: config.calling.dailyLimit,
    dailyDate: state.dailyDate,
    spacingSeconds: config.calling.spacingSeconds,
    maxConcurrent: config.calling.maxConcurrent,
  };
}

module.exports = { enqueue, enqueueFront, getStatus, markCallFinished };
