const ghl = require('../services/ghlService');
const vapi = require('../services/vapiService');
const n8n = require('../services/n8nService');
const { isWithinCallingHours } = require('../utils/callingHours');
const { parseDemoTime } = require('../utils/parseDemoTime');
const { DateTime } = require('luxon');
const config = require('../config');
const { enqueueFront } = require('../utils/callQueue');

function pickPhone(contact) {
  return contact?.phone || contact?.phoneNumber || null;
}

function pickName(contact) {
  if (!contact) return null;
  return contact.fullNameLowerCase || contact.contactName || `${contact.firstName || ''} ${contact.lastName || ''}`.trim() || null;
}

function pickFirstName(contact) {
  if (!contact) return null;
  if (contact.firstName && contact.firstName.trim()) return contact.firstName.trim();
  const full = contact.contactName || contact.fullNameLowerCase || '';
  const first = full.trim().split(/\s+/)[0];
  return first || null;
}

async function triggerCallForContact(contactId) {
  const contact = await ghl.getContact(contactId);
  if (!contact) throw new Error(`Contact ${contactId} not found`);

  const contactTags = contact.tags || [];

  if (contactTags.includes(config.tags.dnc)) {
    console.log(`[call] Skipping ${contactId} - DNC`);
    return { skipped: true, reason: 'dnc' };
  }

  const validQueueTags = [config.tags.queue, config.tags.productionQueue].filter(Boolean);
  const inQueue = validQueueTags.some(t => contactTags.includes(t));
  if (!inQueue) {
    console.log(`[call] Skipping ${contactId} - missing any queue tag (${validQueueTags.join(' or ')})`);
    return { skipped: true, reason: 'not_in_queue', requiredAny: validQueueTags };
  }

  const phone = pickPhone(contact);
  if (!phone) throw new Error(`Contact ${contactId} has no phone`);

  const tz = contact.timezone || config.calling.timezoneDefault;
  if (!isWithinCallingHours(tz)) {
    console.log(`[call] Outside calling hours for ${contactId} (${tz})`);
    return { skipped: true, reason: 'outside_hours' };
  }

  const firstName = pickFirstName(contact);
  console.log(`[call] Dialing ${contactId} | name="${pickName(contact)}" first_name="${firstName || '(none)'}"`);

  const call = await vapi.createOutboundCall({
    phoneNumber: phone,
    contactId,
    name: pickName(contact),
    firstName,
    metadata: { ghlLocationId: config.ghl.locationId },
  });

  console.log(`[call] Started VAPI call ${call.id} for contact ${contactId}`);

  if (config.pipeline.id && config.pipeline.stages.outboundDialled) {
    try {
      await ghl.upsertOpportunityStage({
        contactId,
        pipelineId: config.pipeline.id,
        stageId: config.pipeline.stages.outboundDialled,
        name: `Cold Call — ${pickName(contact) || phone}`,
      });
      console.log(`[ghl] ✅ opportunity -> Outbound Dialled`);
    } catch (err) {
      console.error(`[ghl] ❌ opportunity create FAILED:`, err.response?.data || err.message);
    }
  }

  return { started: true, callId: call.id };
}

function extractStructured(vapiReport) {
  const artifact = vapiReport.artifact || vapiReport.call?.artifact || {};
  const analysis = vapiReport.analysis || vapiReport.call?.analysis || {};

  const soId = config.vapi.structuredOutputId;
  const artifactOutputs = artifact.structuredOutputs || {};
  if (soId && artifactOutputs[soId]?.result) {
    return artifactOutputs[soId].result;
  }
  const firstArtifact = Object.values(artifactOutputs)[0];
  if (firstArtifact?.result) return firstArtifact.result;

  if (analysis.structuredData && Object.keys(analysis.structuredData).length) {
    return analysis.structuredData;
  }
  const analysisOutputs = analysis.structuredOutputs || analysis.structuredOutput || {};
  const firstAnalysis = Object.values(analysisOutputs)[0];
  if (firstAnalysis && typeof firstAnalysis === 'object') {
    return firstAnalysis.result || firstAnalysis.value || firstAnalysis.data || firstAnalysis;
  }
  return {};
}

function classifyOutcome(vapiReport) {
  const analysis = vapiReport.analysis || vapiReport.call?.analysis || {};
  const structured = extractStructured(vapiReport);
  const endedReason = vapiReport.endedReason || vapiReport.call?.endedReason || '';
  const summary = (analysis.summary || '').toLowerCase();

  const carrierNoAnswer = /no[- ]?answer|voicemail|busy|customer-did-not-answer|not-answered|silence-timed-out|twilio-failed|pipeline-error|failed/i.test(endedReason);

  if (structured.demo_booked === true) return 'demo-booked';

  if (structured.outcome === 'no-answer' && !carrierNoAnswer) {
    console.log(`[classify] AI said no-answer but carrier endedReason="${endedReason}" — lead DID pick up. Overriding to not-interested.`);
    return 'not-interested';
  }
  if (structured.outcome) return structured.outcome;

  if (structured.dnc === true || /do not call|don't call|stop calling/.test(summary)) return 'dnc';
  if (carrierNoAnswer) return 'no-answer';
  if (structured.demo_booked === true || /demo (is )?(booked|scheduled|set)|appointment (booked|set|scheduled)|booked (a |the )?demo/.test(summary)) return 'demo-booked';
  if (structured.interested === true || /very interested|sign me up|tell me more|sounds great/.test(summary)) return 'hot-lead';
  if (structured.callback === true || /call ?back|call me later/.test(summary)) return 'callback-requested';
  if (structured.interested === false || /not interested|no thanks/.test(summary)) return 'not-interested';
  if (/maybe|might be|think about|consider|send (me )?(info|details|email)/.test(summary)) return 'warm-lead';
  if (/enquir|question|ask about/.test(summary)) return 'enquiry-logged';

  // No summary means person answered and immediately hung up — retry like a no-answer
  if (!summary) return 'no-answer';

  return 'warm-lead';
}

function buildNote(vapiReport, outcome) {
  const a = vapiReport.analysis || vapiReport.call?.analysis || {};
  const startedAt = vapiReport.startedAt || vapiReport.call?.startedAt || vapiReport.createdAt || new Date().toISOString();
  const endedAt = vapiReport.endedAt || vapiReport.call?.endedAt;
  const durationSec =
    vapiReport.durationSeconds ||
    vapiReport.call?.durationSeconds ||
    (endedAt && startedAt ? Math.round((new Date(endedAt) - new Date(startedAt)) / 1000) : null);
  const recordingUrl = vapiReport.recordingUrl || vapiReport.call?.recordingUrl || vapiReport.stereoRecordingUrl;
  const sd = extractStructured(vapiReport);

  const durationStr = durationSec != null
    ? (durationSec >= 60 ? `${Math.floor(durationSec / 60)}m ${Math.round(durationSec % 60)}s` : `${Math.round(durationSec)}s`)
    : null;

  const dateStr = new Date(startedAt).toLocaleString('en-AU', {
    timeZone: 'Australia/Sydney',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const isDemo = outcome === 'demo-booked';
  const isNoAnswer = outcome === 'no-answer';
  const endedReason = vapiReport.endedReason || vapiReport.call?.endedReason || 'unknown';
  const rawDemoTime = sd.demo_time || sd.callback_time || '';
  const parsedDemoIso = isDemo && rawDemoTime ? parseDemoTime(rawDemoTime, startedAt) : null;
  const parsedDemoPretty = parsedDemoIso
    ? DateTime.fromISO(parsedDemoIso).setZone('Australia/Sydney').toFormat("ccc d LLL yyyy, h:mm a 'AEST'")
    : null;

  let header;
  if (isDemo) header = '🎯 DEMO BOOKED — boss to follow up';
  else if (isNoAnswer) header = `📵 NO ANSWER — ${dateStr} AEST`;
  else header = `AI Cold Call — ${dateStr} AEST`;

  if (isNoAnswer) {
    const reasonPretty = {
      'customer-did-not-answer': 'Lead did not pick up',
      'voicemail': 'Went to voicemail',
      'customer-busy': 'Line was busy',
      'silence-timed-out': 'Picked up but stayed silent',
      'twilio-failed': 'Carrier failed to connect',
      'pipeline-error': 'Technical error before connection',
    }[endedReason] || `Did not connect (${endedReason})`;
    const lines = [
      header,
      `Outcome: no-answer`,
      `Reason: ${reasonPretty}`,
      durationStr ? `Ring duration: ${durationStr}` : null,
      `Next step: retrying immediately (attempt 2).`,
    ].filter(Boolean);
    return lines.join('\n');
  }

  const lines = [
    header,
    isDemo ? `Call date: ${dateStr} AEST` : null,
    `Outcome: ${outcome}`,
    durationStr ? `Duration: ${durationStr}` : null,
    `Sentiment: ${sd.sentiment || 'n/a'}`,
    isDemo && rawDemoTime ? `Demo requested (lead said): ${rawDemoTime}` : null,
    isDemo && parsedDemoPretty ? `Demo time (parsed): ${parsedDemoPretty}` : null,
    isDemo && !parsedDemoPretty && rawDemoTime ? `⚠️ Could not auto-parse demo time — confirm manually` : null,
    !isDemo && sd.callback_time ? `Callback time: ${sd.callback_time}` : null,
    `Follow-up: phone only (lead's number on file)`,
    sd.key_enquiries ? `Enquiries: ${sd.key_enquiries}` : null,
    '',
    'Summary:',
    a.summary || '(no summary)',
    recordingUrl ? `\nRecording: ${recordingUrl}` : null,
  ].filter(Boolean);

  return lines.join('\n');
}

async function handleCallOutcome(vapiReport) {
  const contactId =
    vapiReport.metadata?.ghlContactId ||
    vapiReport.call?.metadata?.ghlContactId ||
    vapiReport.assistantOverrides?.metadata?.ghlContactId ||
    vapiReport.call?.assistantOverrides?.metadata?.ghlContactId;
  if (!contactId) {
    console.warn('[outcome] No ghlContactId in VAPI metadata, skipping');
    return { skipped: true };
  }

  const sd = extractStructured(vapiReport);
  console.log('[outcome] structured data extracted:', JSON.stringify(sd));

  let outcome = classifyOutcome(vapiReport);

  // Double-dial logic: if no-answer AND already tagged for retry, this is attempt 2 → final
  let isNoAnswerFinal = false;
  if (outcome === 'no-answer') {
    const existingContact = await ghl.getContact(contactId).catch(() => null);
    const existingTags = existingContact?.tags || [];
    if (existingTags.includes(config.tags.noAnswerRetry)) {
      isNoAnswerFinal = true;
      console.log(`[outcome] no-answer attempt 2 (retry exhausted) — closing as no-answer-final`);
    } else {
      console.log(`[outcome] no-answer attempt 1 — re-queuing immediately for second dial`);
    }
  }

  const note = buildNote(vapiReport, outcome);

  console.log(`[ghl] writing note to contact ${contactId}...`);
  try {
    await ghl.addNote(contactId, note);
    console.log(`[ghl] ✅ note saved (${note.length} chars)`);
  } catch (err) {
    console.error(`[ghl] ❌ note FAILED:`, err.response?.data || err.message);
  }

  const { tags } = config;
  let tagPlan;
  if (outcome === 'no-answer' && isNoAnswerFinal) {
    // Attempt 2 missed — give up. Drop retry tag + queue, mark final + done.
    tagPlan = { add: [tags.noAnswerFinal, tags.coldCallDone], remove: [tags.noAnswerRetry, tags.queue, tags.productionQueue] };
  } else if (outcome === 'no-answer') {
    // Attempt 1 missed — flag for retry. Keep queue tag so re-enqueue works immediately.
    tagPlan = { add: [tags.noAnswer, tags.noAnswerRetry], remove: [] };
  } else {
    // Reached the lead — clear any pending retry flag along with the normal tag changes
    tagPlan = {
      'hot-lead':           { add: [tags.hotLead, tags.coldCallDone],       remove: [tags.queue, tags.productionQueue, tags.noAnswerRetry] },
      'warm-lead':          { add: ['warm-lead', tags.coldCallDone],        remove: [tags.queue, tags.productionQueue, tags.noAnswerRetry] },
      'demo-booked':        { add: ['demo-booked', 'awaiting-boss-followup', tags.coldCallDone], remove: [tags.queue, tags.productionQueue, tags.noAnswerRetry] },
      'callback-requested': { add: [tags.callback, tags.coldCallDone],      remove: [tags.queue, tags.productionQueue, tags.noAnswerRetry] },
      'not-interested':     { add: [tags.notInterested, tags.coldCallDone], remove: [tags.queue, tags.productionQueue, tags.noAnswerRetry] },
      'dnc':                { add: [tags.dnc, tags.coldCallDone],           remove: [tags.queue, tags.productionQueue, tags.noAnswer, tags.callback, tags.noAnswerRetry] },
      'enquiry-logged':     { add: [tags.enquiry, tags.coldCallDone],       remove: [tags.queue, tags.productionQueue, tags.noAnswerRetry] },
    }[outcome] || { add: [tags.enquiry, tags.coldCallDone], remove: [tags.queue, tags.productionQueue, tags.noAnswerRetry] };
  }

  if (tagPlan.add.length) {
    try {
      await ghl.addTags(contactId, tagPlan.add);
      console.log(`[ghl] ✅ tags added: [${tagPlan.add.join(', ')}]`);
    } catch (err) {
      console.error(`[ghl] ❌ add tags FAILED:`, err.response?.data || err.message);
    }
  }
  if (tagPlan.remove.length) {
    try {
      await ghl.removeTags(contactId, tagPlan.remove);
      console.log(`[ghl] ✅ tags removed: [${tagPlan.remove.join(', ')}]`);
    } catch (err) {
      console.error(`[ghl] ❌ remove tags FAILED:`, err.response?.data || err.message);
    }
  }

  // Attempt 1 no-answer: immediately re-enqueue for second dial (no GHL workflow needed)
  if (outcome === 'no-answer' && !isNoAnswerFinal) {
    console.log(`[outcome] Scheduling immediate retry for ${contactId} — front of queue`);
    enqueueFront(contactId, () => triggerCallForContact(contactId));
  }

  if (config.pipeline.id) {
    const stageMap = {
      'hot-lead':           config.pipeline.stages.hotLead,
      'warm-lead':          config.pipeline.stages.warmLead,
      'demo-booked':        config.pipeline.stages.demoBooked,
      'callback-requested': config.pipeline.stages.warmLead,
      'enquiry-logged':     config.pipeline.stages.contacted,
      'not-interested':     config.pipeline.stages.notInterested,
      'dnc':                config.pipeline.stages.dnc,
      'no-answer':          config.pipeline.stages.outboundDialled,
    };
    const targetStage = isNoAnswerFinal ? config.pipeline.stages.notInterested : stageMap[outcome];
    if (targetStage) {
      try {
        await ghl.upsertOpportunityStage({
          contactId,
          pipelineId: config.pipeline.id,
          stageId: targetStage,
          name: `Cold Call Lead`,
        });
        console.log(`[ghl] ✅ opportunity stage -> ${outcome}`);
      } catch (err) {
        console.error(`[ghl] ❌ opportunity stage update FAILED:`, err.response?.data || err.message);
      }
    }
  }

  if (outcome === 'callback-requested' || outcome === 'demo-booked') {
    const sd2 = extractStructured(vapiReport);
    const rawTime = sd2.demo_time || sd2.callback_time || '';
    const parsedIso = rawTime ? parseDemoTime(rawTime, vapiReport.startedAt || vapiReport.call?.startedAt) : null;
    const dueIso = parsedIso || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const title = outcome === 'demo-booked'
      ? `🎯 Demo booked by AI — call lead to confirm${rawTime ? ` (${rawTime})` : ''}`
      : `Callback requested${rawTime ? ` — ${rawTime}` : ''}`;
    try {
      await ghl.createTask(contactId, {
        title,
        body: outcome === 'demo-booked'
          ? `AI booked a demo with this lead. Their requested time: "${rawTime}". Phone-based follow-up — see latest note for full context + recording.`
          : `AI cold call resulted in callback request. See latest note.`,
        dueDate: dueIso,
      });
      console.log(`[ghl] ✅ follow-up task created (due ${dueIso})`);
    } catch (err) {
      console.error(`[ghl] ❌ task FAILED:`, err.response?.data || err.message);
    }
  }

  try {
    const contact = await ghl.getContact(contactId).catch(() => null);
    const startedAt = vapiReport.startedAt || vapiReport.call?.startedAt || vapiReport.createdAt || new Date().toISOString();
    const endedAt = vapiReport.endedAt || vapiReport.call?.endedAt;
    const durationSec =
      vapiReport.durationSeconds ||
      vapiReport.call?.durationSeconds ||
      (endedAt && startedAt ? Math.round((new Date(endedAt) - new Date(startedAt)) / 1000) : null);
    const recordingUrl = vapiReport.recordingUrl || vapiReport.call?.recordingUrl || vapiReport.stereoRecordingUrl || null;
    const analysisSummary = (vapiReport.analysis || vapiReport.call?.analysis || {}).summary || null;

    const reportedOutcome = isNoAnswerFinal ? 'no-answer-final' : outcome;
    await n8n.notifyCallDone({
      contact_id: contactId,
      first_name: pickFirstName(contact) || '',
      full_name: pickName(contact) || '',
      phone: pickPhone(contact) || '',
      tags: (contact?.tags || []).join(', '),
      outcome: reportedOutcome,
      sentiment: sd.sentiment || null,
      summary: analysisSummary,
      duration_seconds: durationSec,
      recording_url: recordingUrl,
      callback_time: sd.callback_time || null,
      demo_time: sd.demo_time || null,
      key_enquiries: sd.key_enquiries || null,
      note_body: note,
      date_created: startedAt,
    });
  } catch (err) {
    console.error('[n8n] notify build FAILED:', err.message);
  }

  const finalOutcome = isNoAnswerFinal ? 'no-answer-final' : outcome;
  console.log(`[outcome] Contact ${contactId} -> ${finalOutcome}`);
  return { contactId, outcome: finalOutcome };
}

module.exports = { triggerCallForContact, handleCallOutcome, classifyOutcome };
