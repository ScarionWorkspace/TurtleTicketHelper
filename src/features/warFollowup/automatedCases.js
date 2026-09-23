'use strict';

const workflow = require('./workflow');

const AUTOMATED_CATEGORIES = new Set(['regular_missed', 'regular_performance', 'cwl_missed']);
const REGULAR_WAR_TARGET = 3;
const PERFORMANCE_ATTACK_TARGET = 6;
const CWL_ATTACK_TARGET = 2;
const AUTO_DM_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

function text(value) {
    return value == null ? '' : String(value).trim();
}

function categoryForItem(item) {
    if (!item?.player?.automaticEligible || !item?.case && !item?.signals?.length) return '';
    const signals = Array.isArray(item.signals) ? item.signals : [];
    return signals.length === 1 && AUTOMATED_CATEGORIES.has(signals[0].reasonCode)
        ? signals[0].reasonCode : '';
}

function canSendAutomaticDm(item, workspace, config, nowRaw = new Date(), stage = 'checkin') {
    if (config?.features?.directMessages !== true || config?.features?.autoCaseDms !== true) return false;
    if (stage === 'warning' && !item?.case?.automationLastDmAt) return false;
    const discordId = text(item?.player?.discordId);
    if (!/^\d{17,20}$/.test(discordId)) return false;
    const nowMs = new Date(nowRaw).getTime();
    for (const other of workspace?.work?.items || []) {
        if (text(other?.player?.discordId || other?.case?.discordId) !== discordId) continue;
        if (other.tag !== item.tag && ['needs_dm', 'waiting', 'watching'].includes(other.status) && other.case?.dmQueueId) return false;
        if (other.tag === item.tag && stage === 'warning') continue;
        const sentMs = workflow.parseMs(other.case?.automationLastDmAt || other.case?.dmSentAt);
        if (sentMs > 0 && nowMs - sentMs >= 0 && nowMs - sentMs < AUTO_DM_COOLDOWN_MS) return false;
    }
    return true;
}

function automaticMessage(item, category, stage) {
    const player = text(item?.player?.name) || 'there';
    const tag = text(item?.tag);
    const lead = `Hi ${player}. This is the TURTLE war follow-up bot about ${tag}.`;
    const reply = 'If the record is wrong or you need to explain something, reply to this message and a leader will review it.';
    if (category === 'regular_missed') {
        const missed = Number(item?.evidence?.regular?.missedAttacks) || 0;
        return stage === 'warning'
            ? `${lead} Another regular-war attack was missed after our check-in. Please keep your in-game war availability current. We will watch your next eligible wars; another miss may lead to a leader reviewing a recovery-clan move. ${reply}`
            : `${lead} Our completed-war records show ${missed} missed regular-war attacks in the recent review window. One-off situations happen. Please keep your in-game war availability current; we will watch the next three wars you are selected for. ${reply}`;
    }
    if (category === 'regular_performance') {
        return stage === 'warning'
            ? `${lead} Recent regular-war results remain below the clan's configured review targets after the first check-in. We will review the next six counted attacks before a leader considers a recovery-clan move. ${reply}`
            : `${lead} Recent regular-war results fell below both configured review targets. This is a check-in, not a sanction. We will consider your next six counted attacks, including target difficulty where recorded. ${reply}`;
    }
    return stage === 'warning'
        ? `${lead} Another CWL attack was missed after our first check-in. Please keep your war availability current. A further missed CWL opportunity will go to a leader for review. ${reply}`
        : `${lead} A CWL attack was missed in the recent season. Please keep your war availability current. This is a check-in; the next two CWL opportunities will be observed. ${reply}`;
}

function regularEventsAfter(item, historyRaw) {
    const startMs = workflow.parseMs(item?.case?.automationWindowStartAt);
    const events = historyRaw?.regularEvents?.length
        ? historyRaw.regularEvents : (item?.currentEvidence?.regularEvents || []);
    return events
        .filter(event => workflow.parseMs(event?.at) > startMs && Number(event?.stats?.possibleAttacks) > 0)
        .sort((a, b) => workflow.parseMs(a.at) - workflow.parseMs(b.at));
}

function regularMissedProgress(item, history) {
    const events = regularEventsAfter(item, history).slice(0, REGULAR_WAR_TARGET);
    const missed = events.reduce((sum, event) => sum + (Number(event?.stats?.missedAttacks) || 0), 0);
    const fullMisses = events.filter(event => Number(event?.stats?.missedAttacks) >= Number(event?.stats?.possibleAttacks)).length;
    const latest = (history?.regularEvents || [])
        .filter(event => Number(event?.stats?.possibleAttacks) > 0)
        .slice(0, 6);
    const possible = latest.reduce((sum, event) => sum + (Number(event.stats.possibleAttacks) || 0), 0);
    const used = latest.reduce((sum, event) => sum + (Number(event.stats.usedAttacks) || 0), 0);
    return {
        ready: events.length >= REGULAR_WAR_TARGET || (item.case.automationStage === 'checkin' && fullMisses >= 2),
        completedWars: events.length,
        targetWars: REGULAR_WAR_TARGET,
        missed,
        fullMisses,
        engaged: possible > 0 && used / possible >= 0.5
    };
}

function regularPerformanceProgress(item, settings, history) {
    const events = regularEventsAfter(item, history);
    const counted = events.reduce((sum, event) => sum + (Number(event?.stats?.countedAttacks) || 0), 0);
    const fullMisses = events.filter(event =>
        Number(event?.stats?.possibleAttacks) > 0 &&
        Number(event?.stats?.missedAttacks) >= Number(event?.stats?.possibleAttacks)
    ).length;
    const attendanceFailure = fullMisses >= 2 || (events.length >= 6 && counted < PERFORMANCE_ATTACK_TARGET);
    const ready = attendanceFailure || (events.length >= REGULAR_WAR_TARGET && counted >= PERFORMANCE_ATTACK_TARGET);
    const totals = {
        possibleAttacks: events.reduce((sum, event) => sum + (Number(event?.stats?.possibleAttacks) || 0), 0),
        usedAttacks: events.reduce((sum, event) => sum + (Number(event?.stats?.usedAttacks) || 0), 0),
        missedAttacks: events.reduce((sum, event) => sum + (Number(event?.stats?.missedAttacks) || 0), 0),
        countedAttacks: counted,
        starsTotal: events.reduce((sum, event) => sum + (Number(event?.stats?.starsTotal) || 0), 0),
        totalDestruction: events.reduce((sum, event) => sum + (Number(event?.stats?.totalDestruction) || 0), 0),
        warCount: events.length
    };
    totals.averageStars = counted ? totals.starsTotal / counted : 0;
    totals.averageDestruction = counted ? totals.totalDestruction / counted : 0;
    const signals = ready ? workflow.buildSignals({ regular: totals, regularEvents: events, cwl: {}, cwlEvents: [] }, {
        ...settings, regularMinimumAttacks: 6, regularMissedThreshold: 16, cwlMissedThreshold: 8
    }) : [];
    return {
        ready,
        completedWars: events.length,
        targetWars: REGULAR_WAR_TARGET,
        missed: totals.missedAttacks,
        fullMisses,
        attendanceFailure,
        problemContinues: signals.some(signal => signal.reasonCode === 'regular_performance')
    };
}

function cwlProgress(item) {
    const baseline = new Map((item?.case?.evidence?.cwlEvents || []).map(event => [event.id, event]));
    let possible = 0;
    let missed = 0;
    for (const current of item?.currentEvidence?.cwlEvents || []) {
        const previous = baseline.get(current.id);
        possible += Math.max(0, (Number(current?.stats?.possibleAttacks) || 0) - (Number(previous?.stats?.possibleAttacks) || 0));
        missed += Math.max(0, (Number(current?.stats?.missedAttacks) || 0) - (Number(previous?.stats?.missedAttacks) || 0));
    }
    return { ready: possible >= CWL_ATTACK_TARGET, completedWars: possible, targetWars: CWL_ATTACK_TARGET, missed };
}

function progressForItem(item, workspace) {
    const category = text(item?.case?.automationCategory);
    const history = category.startsWith('regular_')
        ? workflow.buildWarHistoryForTag(workspace.rosterData, item.tag, item.player) : null;
    if (category === 'regular_missed') {
        return regularMissedProgress(item, history);
    }
    if (category === 'regular_performance') return regularPerformanceProgress(item, workspace.work.settings, history);
    if (category === 'cwl_missed') return cwlProgress(item);
    return { ready: false, completedWars: 0, targetWars: 0 };
}

module.exports = {
    categoryForItem,
    canSendAutomaticDm,
    automaticMessage,
    progressForItem
};
