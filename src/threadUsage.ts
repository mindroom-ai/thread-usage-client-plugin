import { useCallback, useSyncExternalStore } from 'react';
import {
  Direction,
  EventType,
  RelationType,
  RoomEvent,
  ThreadEvent,
  type EventTimeline,
  type EventTimelineSet,
  type MatrixClient,
  type MatrixEvent,
  type Room,
  type Thread,
} from 'matrix-js-sdk';
import { isMindroomAgentUserId, useMatrixClient } from '@mindroom/client-sdk/matrix';
import { clampContextPercentage } from './format';

export const PLUGIN_ID = 'thread-usage';

const AI_RUN_KEY = 'io.mindroom.ai_run';
const STREAM_STATUS_KEY = 'io.mindroom.stream_status';
const MICROS_PER_USD = 1_000_000;
const DECIMAL_STRING = /^\d+(\.\d+)?(e[-+]?\d+)?$/i;
const UNKNOWN_COST_ENDINGS = new Set(['cancelled', 'error', 'interrupted']);

export const TOKEN_KINDS = ['cacheRead', 'cacheWrite', 'notCached', 'newInput', 'input', 'output'] as const;

export type TokenKind = (typeof TOKEN_KINDS)[number];
export type TokenCounts = Partial<Record<TokenKind, number>>;

export type ThreadContextUsage = {
  inputTokens: number;
  windowTokens: number;
  percentage: number;
  cacheReadTokens?: number;
  uncachedTokens?: number;
};

export type ThreadUsageSummary = {
  totalCostUsd?: number;
  subagentsCostUsd: number;
  pricedReplyCount: number;
  totalTokens?: number;
  tokenCounts: TokenCounts;
  tokenReplyCount: number;
  models: readonly string[];
  context?: ThreadContextUsage;
  costComplete: boolean;
  complete: boolean;
  tokensComplete: boolean;
  historyComplete: boolean;
};

export type ThreadUsageConfig = { showCost: boolean; showTokens: boolean; showModels: boolean; showContext: boolean };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const matchesEnum = <T extends string>(v: string | undefined, expected: T): v is T =>
  v === String(expected);
const asFinite = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const asDecimal = (v: unknown): number | undefined => {
  const n = asFinite(typeof v === 'string' && DECIMAL_STRING.test(v) ? Number(v) : v);
  return n !== undefined && n >= 0 ? n : undefined;
};
const serverOf = (userId: string): string | undefined => {
  const colon = userId.startsWith('@') ? userId.indexOf(':') : -1;
  return colon >= 2 && colon < userId.length - 1 ? userId.slice(colon + 1) : undefined;
};
const isTrustedAgent = (sender: string | undefined, viewerId: string | undefined): boolean => {
  if (!sender || !viewerId || !isMindroomAgentUserId(sender)) return false;
  const server = serverOf(sender);
  return server !== undefined && server === serverOf(viewerId);
};

/** Parses `plugins["thread-usage"]` options with all card toggles defaulting to `true`. */
export function readUsageConfig(raw: unknown): ThreadUsageConfig {
  const cfg = isRecord(raw) ? raw : undefined;
  return {
    showCost: cfg?.showCost !== false,
    showTokens: cfg?.showTokens !== false,
    showModels: cfg?.showModels !== false,
    showContext: cfg?.showContext !== false,
  };
}

const collectThreadEvents = (thread: Thread) => {
  const live =
    thread.getUnfilteredTimelineSet?.()?.getLiveTimeline?.() ??
    thread.timelineSet?.getLiveTimeline?.();
  const linked: EventTimeline[] = [];
  if (live) {
    const back = new Set<EventTimeline>([live]);
    let oldest = live;
    for (let p = oldest.getNeighbouringTimeline(Direction.Backward); p; p = oldest.getNeighbouringTimeline(Direction.Backward)) {
      if (back.has(p)) { oldest = live; break; }
      back.add(p);
      oldest = p;
    }
    const fwd = new Set<EventTimeline>();
    for (let c: EventTimeline | null = oldest; c && !fwd.has(c); c = c.getNeighbouringTimeline(Direction.Forward)) {
      fwd.add(c);
      linked.push(c);
    }
  }
  const seen = new Set<string>();
  const events: MatrixEvent[] = [];
  for (const ev of [...linked.flatMap((tl) => tl.getEvents()), ...(thread.events ?? [])]) {
    const id = ev.getId();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    events.push(ev);
  }
  return { events, oldest: linked[0] };
};

const isReactionOrEdit = (ev: MatrixEvent): boolean =>
  matchesEnum(ev.getType(), EventType.Reaction) ||
  matchesEnum(ev.getRelation()?.rel_type, RelationType.Annotation) ||
  matchesEnum(ev.getRelation()?.rel_type, RelationType.Replace);

const getAiRun = (content: Record<string, unknown>): Record<string, unknown> | undefined => {
  const nc = isRecord(content['m.new_content']) ? content['m.new_content'] : undefined;
  if (nc && isRecord(nc[AI_RUN_KEY]) && nc[AI_RUN_KEY].version === 1) return nc[AI_RUN_KEY];
  return isRecord(content[AI_RUN_KEY]) && content[AI_RUN_KEY].version === 1 ? content[AI_RUN_KEY] : undefined;
};

const getStreamStatus = (content: Record<string, unknown>): string | undefined => {
  const nc = isRecord(content['m.new_content']) ? content['m.new_content'] : undefined;
  const read = (raw: unknown): string | undefined => {
    const str = typeof raw === 'string' ? raw : isRecord(raw) ? (raw.status ?? raw.state) : undefined;
    return typeof str === 'string' && str.length > 0 ? str.toLowerCase() : undefined;
  };
  return read(nc?.[STREAM_STATUS_KEY]) ?? read(content[STREAM_STATUS_KEY]);
};

const resolveReplyMetadata = (room: Room, thread: Thread, ev: MatrixEvent, eventId: string) => {
  const sender = ev.getSender();
  const applied = ev.replacingEvent?.();
  const raw: MatrixEvent[] = [];
  const types = new Set<string>([String(EventType.RoomMessage), ev.getType()]);
  const gather = (ts: Pick<EventTimelineSet, 'relations'> | undefined) => {
    for (const type of types) {
      const rel = ts?.relations?.getChildEventsForEvent(eventId, RelationType.Replace, type);
      if (rel) raw.push(...rel.getRelations());
    }
  };
  gather(thread.timelineSet);
  if (eventId === thread.id) gather(room.getUnfilteredTimelineSet?.());
  if (applied) raw.push(applied);

  const seen = new Set<string | MatrixEvent>();
  const edits: MatrixEvent[] = [];
  for (const cand of raw) {
    const key = cand.getId() ?? cand;
    if (seen.has(key)) continue;
    if (!sender || cand.getSender() !== sender || cand.isRedacted() || cand.isDecryptionFailure?.()) continue;
    if (matchesEnum(cand.getType(), EventType.RoomMessageEncrypted) || !isRecord(cand.getContent()['m.new_content'])) continue;
    const rel = cand.getRelation();
    if (rel ? !matchesEnum(rel.rel_type, RelationType.Replace) || rel.event_id !== eventId : cand !== applied) continue;
    seen.add(key);
    edits.push(cand);
  }
  edits.sort((a, b) => {
    const diff = b.getTs() - a.getTs();
    if (diff !== 0) return diff;
    const aId = a.getId() ?? '';
    const bId = b.getId() ?? '';
    return bId > aId ? 1 : bId < aId ? -1 : 0;
  });

  const ownContent: Record<string, unknown> = applied ? ev.getOriginalContent() : ev.getContent();
  let aiRun: Record<string, unknown> | undefined;
  let streamStatus: string | undefined;
  for (const content of [...edits.map((e) => e.getContent()), ownContent]) {
    aiRun ??= getAiRun(content);
    streamStatus ??= getStreamStatus(content);
    if (aiRun && streamStatus) break;
  }
  return { aiRun, streamStatus };
};

const extractReplyTokens = (usage: Record<string, unknown> | undefined): TokenCounts => {
  if (!usage) return {};
  const counts: TokenCounts = {};
  const add = (kind: TokenKind, v: unknown) => {
    const n = asFinite(v);
    if (n !== undefined && n > 0) counts[kind] = n;
  };
  const uncached = asFinite(usage.uncached_input_tokens);
  if (uncached === undefined) {
    add('input', usage.input_tokens);
  } else {
    add('cacheRead', usage.cache_read_tokens);
    const cacheWrite = asFinite(usage.cache_write_tokens);
    if (cacheWrite === undefined) add('newInput', uncached);
    else {
      const clamped = Math.max(0, uncached);
      const writes = Math.min(Math.max(0, cacheWrite), clamped);
      add('cacheWrite', writes);
      add('notCached', clamped - writes);
    }
  }
  add('output', usage.output_tokens);
  return counts;
};

const extractModelLabel = (model: Record<string, unknown> | undefined): string | undefined => {
  if (!model) return undefined;
  const display = typeof model.display_name === 'string' ? model.display_name.trim() : '';
  if (display) return display;
  const id = typeof model.id === 'string' ? model.id.trim() : '';
  if (id) return id.slice(id.lastIndexOf('/') + 1).trim() || id;
  return typeof model.config === 'string' ? model.config.trim() || undefined : undefined;
};

const extractContext = (ctx: Record<string, unknown> | undefined): ThreadContextUsage | undefined => {
  if (!ctx) return undefined;
  const inputTokens = asFinite(ctx.input_tokens);
  const windowTokens = asFinite(ctx.window_tokens);
  if (inputTokens === undefined || inputTokens < 0 || windowTokens === undefined || windowTokens <= 0) {
    return undefined;
  }
  const rawCache = asFinite(ctx.cache_read_input_tokens);
  const rawUncached = asFinite(ctx.uncached_input_tokens);
  const hasCache = rawCache !== undefined && rawCache >= 0;
  const cacheReadTokens = hasCache ? Math.min(rawCache, inputTokens) : undefined;
  const uncachedTokens =
    hasCache && cacheReadTokens !== undefined
      ? rawUncached !== undefined && rawUncached >= 0 && rawCache + rawUncached === inputTokens
        ? rawUncached
        : Math.max(0, inputTokens - cacheReadTokens)
      : undefined;
  return {
    inputTokens,
    windowTokens,
    percentage: clampContextPercentage((inputTokens / windowTokens) * 100),
    cacheReadTokens,
    uncachedTokens,
  };
};

/** Summarizes AI run telemetry across all currently loaded events of `threadId` in `room`. */
export function summarizeThreadUsage(
  room: Room,
  threadId: string,
  viewerId: string | undefined,
  isUserIgnored?: (userId: string) => boolean
): ThreadUsageSummary | undefined {
  const thread = room.getThread(threadId);
  if (!thread) return undefined;

  const { events, oldest } = collectThreadEvents(thread);
  const historyComplete =
    thread.initialEventsFetched === true &&
    oldest?.getEvents()[0]?.getId() === thread.id &&
    typeof oldest.getPaginationToken(Direction.Backward) !== 'string';

  let totalMicros = 0;
  let subagentsMicros = 0;
  let pricedReplyCount = 0;
  let unknownCost = false;
  const tokenCounts: TokenCounts = {};
  let totalTokensSum = 0;
  let tokenReplyCount = 0;
  const seenModels = new Set<string>();
  let latestContext: ThreadContextUsage | undefined;

  for (const ev of events) {
    const eventId = ev.getId();
    if (!eventId || ev.isRedacted() || isReactionOrEdit(ev)) continue;
    const sender = ev.getSender() ?? '';
    if (!isTrustedAgent(sender, viewerId) || isUserIgnored?.(sender)) continue;

    const { aiRun, streamStatus } = resolveReplyMetadata(room, thread, ev, eventId);
    const cost = isRecord(aiRun?.cost) ? aiRun.cost : undefined;
    const costUsd = asDecimal(cost?.usd);
    const subUsd = asDecimal(cost?.subagents_usd);
    if (costUsd === undefined) {
      const ending = (typeof aiRun?.status === 'string' ? aiRun.status.toLowerCase() : undefined) ?? streamStatus;
      if (ending && UNKNOWN_COST_ENDINGS.has(ending)) unknownCost = true;
    }
    if (costUsd !== undefined || subUsd !== undefined) {
      const own = costUsd !== undefined ? Math.round(costUsd * MICROS_PER_USD) : 0;
      const sub = subUsd !== undefined ? Math.round(subUsd * MICROS_PER_USD) : 0;
      totalMicros += own + sub;
      subagentsMicros += sub;
      pricedReplyCount += 1;
    }
    if (!aiRun) continue;

    const replyTokens = extractReplyTokens(isRecord(aiRun.usage) ? aiRun.usage : undefined);
    let replyTotal = 0;
    for (const kind of TOKEN_KINDS) {
      const n = replyTokens[kind];
      if (n) {
        tokenCounts[kind] = (tokenCounts[kind] ?? 0) + n;
        replyTotal += n;
      }
    }
    if (replyTotal > 0) {
      totalTokensSum += replyTotal;
      tokenReplyCount += 1;
    }
    const label = extractModelLabel(isRecord(aiRun.model) ? aiRun.model : undefined);
    if (label) {
      seenModels.delete(label);
      seenModels.add(label);
    }
    const ctx = extractContext(isRecord(aiRun.context) ? aiRun.context : undefined);
    if (ctx) latestContext = ctx;
  }

  const models = [...seenModels].reverse();
  if (!pricedReplyCount && !tokenReplyCount && !models.length && !latestContext) return undefined;
  const costComplete = historyComplete && !unknownCost;
  return {
    totalCostUsd: pricedReplyCount > 0 ? totalMicros / MICROS_PER_USD : undefined,
    subagentsCostUsd: subagentsMicros / MICROS_PER_USD,
    pricedReplyCount,
    totalTokens: tokenReplyCount > 0 ? totalTokensSum : undefined,
    tokenCounts,
    tokenReplyCount,
    models,
    context: latestContext,
    costComplete,
    complete: costComplete,
    tokensComplete: historyComplete,
    historyComplete,
  };
}

const viewerFrom = (c?: MatrixClient): string | undefined =>
  typeof c?.getUserId === 'function'
    ? (c.getUserId() ?? undefined)
    : typeof c?.getSafeUserId === 'function'
      ? c.getSafeUserId()
      : undefined;
const getViewerId = (room: Room, fallback?: MatrixClient) =>
  viewerFrom(room.client) ?? (room.myUserId || undefined) ?? viewerFrom(fallback);

const getIgnored = (room: Room, fallback?: MatrixClient): ((u: string) => boolean) | undefined => {
  const src = typeof room.client?.isUserIgnored === 'function' ? room.client : fallback;
  return typeof src?.isUserIgnored === 'function' ? (u) => src.isUserIgnored(u) : undefined;
};

/** Synchronous check for `threadDetails.shows`. */
export function threadHasUsage(room: Room, threadId: string): boolean {
  return summarizeThreadUsage(room, threadId, getViewerId(room), getIgnored(room)) !== undefined;
}

const sameSummary = (a: ThreadUsageSummary | undefined, b: ThreadUsageSummary | undefined) =>
  a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b));

// Shared per-Room WeakMap event multiplexer: 1 listener per event type on `room` across all cards.
type ThreadChannel = { listeners: Set<() => void>; thread?: Thread; stopThread?: () => void; dirty: boolean };
type RoomUsageBus = {
  channels: Map<string, ThreadChannel>;
  snapshots: Map<string, { viewerId?: string; snapshot?: ThreadUsageSummary }>;
  stopRoom?: () => void;
};

const roomBuses = new WeakMap<Room, RoomUsageBus>();
const busOf = (room: Room): RoomUsageBus => {
  let bus = roomBuses.get(room);
  if (!bus) {
    bus = { channels: new Map(), snapshots: new Map() };
    roomBuses.set(room, bus);
  }
  return bus;
};

const notifyThread = (bus: RoomUsageBus, threadId: string) => {
  const ch = bus.channels.get(threadId);
  if (!ch) return;
  ch.dirty = true;
  ch.listeners.forEach((fn) => fn());
};

const attachThread = (bus: RoomUsageBus, room: Room, threadId: string, ch: ThreadChannel) => {
  const thread = room.getThread(threadId) ?? undefined;
  if (ch.thread === thread) return;
  ch.stopThread?.();
  ch.thread = thread;
  ch.stopThread = undefined;
  if (!thread || typeof thread.on !== 'function' || typeof thread.off !== 'function') return;
  const onChange = () => notifyThread(bus, threadId);
  const events = [ThreadEvent.Update, ThreadEvent.NewReply] as const;
  events.forEach((ev) => thread.on(ev, onChange));
  ch.stopThread = () => events.forEach((ev) => thread.off(ev, onChange));
};

const threadHolding = (room: Room, bus: RoomUsageBus, targetId: string): string | undefined => {
  if (bus.channels.has(targetId)) return targetId;
  const found = room.findEventById?.(targetId)?.threadRootId;
  if (found && bus.channels.has(found)) return found;
  for (const tid of bus.channels.keys()) {
    const th = room.getThread(tid);
    if (th && (th.rootEvent?.getId() === targetId || th.findEventById?.(targetId) !== undefined || th.events?.some((e) => e.getId() === targetId))) {
      return tid;
    }
  }
  return undefined;
};

const ensureRoomBus = (room: Room, bus: RoomUsageBus) => {
  if (bus.stopRoom || typeof room.on !== 'function' || typeof room.off !== 'function') return;
  const onTimeline = (ev: MatrixEvent, _r: Room | undefined, _s: boolean | undefined, _rem: boolean, data: { timeline?: EventTimeline } | undefined) => {
    const direct = data?.timeline?.getTimelineSet?.()?.thread?.id ?? ev.threadRootId;
    if (direct) { notifyThread(bus, direct); return; }
    const id = ev.getId();
    if (id && bus.channels.has(id)) { notifyThread(bus, id); return; }
    const rel = ev.getRelation();
    if (!rel?.event_id) return;
    if (matchesEnum(rel.rel_type, RelationType.Thread)) notifyThread(bus, rel.event_id);
    else if (matchesEnum(rel.rel_type, RelationType.Replace)) {
      const tid = threadHolding(room, bus, rel.event_id);
      if (tid) notifyThread(bus, tid);
    }
  };
  const onRedaction = (ev: MatrixEvent, _r: Room, tid?: string) => {
    const assoc = ev.getAssociatedId?.();
    const hit = tid ?? (assoc ? threadHolding(room, bus, assoc) : undefined);
    if (hit) notifyThread(bus, hit);
    else bus.channels.forEach((_, key) => notifyThread(bus, key));
  };
  const onReset = (_r: Room | undefined, ts?: EventTimelineSet) => {
    if (ts?.thread?.id) notifyThread(bus, ts.thread.id);
    else bus.channels.forEach((_, key) => notifyThread(bus, key));
  };
  const onThread = (th: Thread) => {
    const ch = bus.channels.get(th.id);
    if (!ch) return;
    attachThread(bus, room, th.id, ch);
    notifyThread(bus, th.id);
  };
  const threadEvents = [ThreadEvent.New, ThreadEvent.Update, ThreadEvent.NewReply, ThreadEvent.Delete] as const;
  room.on(RoomEvent.Timeline, onTimeline);
  room.on(RoomEvent.Redaction, onRedaction);
  room.on(RoomEvent.TimelineReset, onReset);
  threadEvents.forEach((ev) => room.on(ev, onThread));
  bus.stopRoom = () => {
    room.off(RoomEvent.Timeline, onTimeline);
    room.off(RoomEvent.Redaction, onRedaction);
    room.off(RoomEvent.TimelineReset, onReset);
    threadEvents.forEach((ev) => room.off(ev, onThread));
    bus.stopRoom = undefined;
  };
};

const subscribeThread = (room: Room, threadId: string, fn: () => void): (() => void) => {
  const bus = busOf(room);
  let ch = bus.channels.get(threadId);
  if (!ch) {
    ch = { listeners: new Set(), dirty: true };
    bus.channels.set(threadId, ch);
  }
  ch.listeners.add(fn);
  ensureRoomBus(room, bus);
  attachThread(bus, room, threadId, ch);
  return () => {
    ch.listeners.delete(fn);
    if (ch.listeners.size > 0) return;
    ch.stopThread?.();
    bus.channels.delete(threadId);
    bus.snapshots.delete(threadId);
    if (bus.channels.size === 0) bus.stopRoom?.();
  };
};

const readSnapshot = (
  room: Room,
  threadId: string,
  viewerId: string | undefined,
  ignored?: (u: string) => boolean
): ThreadUsageSummary | undefined => {
  const bus = busOf(room);
  const ch = bus.channels.get(threadId);
  const cached = bus.snapshots.get(threadId);
  if (ch && !ch.dirty && cached && cached.viewerId === viewerId) return cached.snapshot;
  const next = summarizeThreadUsage(room, threadId, viewerId, ignored);
  const snapshot = cached && sameSummary(cached.snapshot, next) ? cached.snapshot : next;
  bus.snapshots.set(threadId, { viewerId, snapshot });
  if (ch) ch.dirty = false;
  return snapshot;
};

/** Live hook returning AI run telemetry for `threadId` in `room` via the shared per-Room bus. */
export function useThreadUsage(room: Room, threadId: string): ThreadUsageSummary | undefined {
  const client = useMatrixClient();
  const viewerId = getViewerId(room, client);
  const ignored = getIgnored(room, client);
  const subscribe = useCallback(
    (notify: () => void) => subscribeThread(room, threadId, notify),
    [room, threadId]
  );
  return useSyncExternalStore(subscribe, () => readSnapshot(room, threadId, viewerId, ignored));
}
