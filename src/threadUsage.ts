import { useCallback, useRef, useSyncExternalStore } from 'react';
import {
  ClientEvent,
  Direction,
  EventType,
  MatrixEvent,
  MatrixEventEvent,
  RelationType,
  RoomEvent,
  ThreadEvent,
  type EventTimeline,
  type EventTimelineSet,
  type MatrixClient,
  type Room,
  type Thread,
} from 'matrix-js-sdk';
import { isMindroomAgentUserId, useMatrixClient } from '@mindroom/client-sdk/matrix';
import { clampContextPercentage, formatModelLabel } from './format';

export const PLUGIN_ID = 'thread-usage';
const AI_RUN_KEY = 'io.mindroom.ai_run';
const STREAM_STATUS_KEY = 'io.mindroom.stream_status';
const IGNORED_USERS_EVENT = 'm.ignored_user_list';
const MICROS_PER_USD = 1_000_000;
const DECIMAL_STRING = /^\d+(\.\d+)?(e[-+]?\d+)?$/i;
const UNKNOWN_COST_ENDINGS = new Set(['cancelled', 'error', 'interrupted']);
const THREAD_EVENTS = [
  ThreadEvent.New,
  ThreadEvent.Update,
  ThreadEvent.NewReply,
  ThreadEvent.Delete,
] as const;

export const TOKEN_KINDS = [
  'cacheRead',
  'cacheWrite',
  'notCached',
  'newInput',
  'input',
  'output',
] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];
export type TokenCounts = Partial<Record<TokenKind, number>>;
export type ThreadContextUsage = {
  inputTokens: number;
  windowTokens: number;
  percentage: number;
  cacheReadTokens?: number;
};
export type ThreadUsageConfig = {
  showCost: boolean;
  showTokens: boolean;
  showModels: boolean;
  showContext: boolean;
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
  tokensComplete: boolean;
};

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
const isTrustedAgent = (sender: string | undefined, viewerId: string | undefined): boolean =>
  !!sender &&
  !!viewerId &&
  isMindroomAgentUserId(sender) &&
  serverOf(sender) !== undefined &&
  serverOf(sender) === serverOf(viewerId);

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
    const visited = new Set<EventTimeline>([live]);
    let oldest = live;
    for (
      let p = oldest.getNeighbouringTimeline(Direction.Backward);
      p;
      p = oldest.getNeighbouringTimeline(Direction.Backward)
    ) {
      if (visited.has(p)) {
        oldest = live;
        break;
      }
      visited.add(p);
      oldest = p;
    }
    visited.clear();
    for (
      let c: EventTimeline | null = oldest;
      c && !visited.has(c);
      c = c.getNeighbouringTimeline(Direction.Forward)
    ) {
      visited.add(c);
      linked.push(c);
    }
  }
  const seen = new Set<string>();
  const events: MatrixEvent[] = [];
  for (const ev of [...linked.flatMap((tl) => tl.getEvents()), ...(thread.events ?? [])]) {
    const id = ev.getId();
    if (id && !seen.has(id)) {
      seen.add(id);
      events.push(ev);
    }
  }
  const root = thread.rootEvent;
  const rootId = root?.getId();
  if (root && rootId && !seen.has(rootId)) {
    seen.add(rootId);
    events.unshift(root);
  }
  const reply = thread.replyToEvent;
  const replyId = reply?.getId();
  if (reply && replyId && !seen.has(replyId)) {
    seen.add(replyId);
    events.push(reply);
  }
  return { events, oldest: linked[0] };
};

const isReactionOrEdit = (ev: MatrixEvent): boolean =>
  matchesEnum(ev.getType(), EventType.Reaction) ||
  matchesEnum(ev.getRelation()?.rel_type, RelationType.Annotation) ||
  matchesEnum(ev.getRelation()?.rel_type, RelationType.Replace);

const contentLayers = (content: Record<string, unknown>) =>
  isRecord(content['m.new_content']) ? [content['m.new_content'], content] : [content];

const getAiRun = (content: Record<string, unknown>): Record<string, unknown> | undefined =>
  contentLayers(content)
    .map((l) => l[AI_RUN_KEY])
    .find((r): r is Record<string, unknown> => isRecord(r) && r.version === 1);

const getStreamStatus = (content: Record<string, unknown>): string | undefined => {
  for (const layer of contentLayers(content)) {
    const raw = layer[STREAM_STATUS_KEY];
    const str =
      typeof raw === 'string' ? raw : isRecord(raw) ? (raw.status ?? raw.state) : undefined;
    if (typeof str === 'string' && str.length > 0) return str.toLowerCase();
  }
  return undefined;
};

const resolveReplyMetadata = (thread: Thread, ev: MatrixEvent, eventId: string) => {
  const sender = ev.getSender();
  const applied = ev.replacingEvent?.() ?? undefined;
  const raw: MatrixEvent[] = applied ? [applied] : [];
  for (const type of new Set<string>([String(EventType.RoomMessage), ev.getType()])) {
    const rel = thread.timelineSet?.relations?.getChildEventsForEvent(
      eventId,
      RelationType.Replace,
      type
    );
    if (rel) raw.push(...rel.getRelations());
  }
  const rels = ev.getUnsigned?.()?.['m.relations'];
  const bundledRaw = isRecord(rels) ? rels[RelationType.Replace] : undefined;
  const bundled =
    isRecord(bundledRaw) &&
    typeof bundledRaw.event_id === 'string' &&
    bundledRaw.event_id &&
    (asFinite(bundledRaw.origin_server_ts) ?? 0) > 0
      ? new MatrixEvent({ ...bundledRaw })
      : undefined;
  if (bundled) raw.push(bundled);

  const seen = new Set<string | MatrixEvent>();
  const edits: MatrixEvent[] = [];
  for (const cand of raw) {
    const key = cand.getId() ?? cand;
    if (seen.has(key)) continue;
    if (cand.isRedacted()) {
      seen.add(key);
      continue;
    }
    if (!sender || cand.getSender() !== sender || cand.isDecryptionFailure?.()) continue;
    if (
      matchesEnum(cand.getType(), EventType.RoomMessageEncrypted) ||
      !isRecord(cand.getContent()['m.new_content'])
    )
      continue;
    const rel = cand.getRelation();
    if (
      rel
        ? !matchesEnum(rel.rel_type, RelationType.Replace) || rel.event_id !== eventId
        : cand !== applied && cand !== bundled
    )
      continue;
    seen.add(key);
    edits.push(cand);
  }
  edits.sort((a, b) => {
    const diff = b.getTs() - a.getTs();
    return diff !== 0
      ? diff
      : (b.getId() ?? '') > (a.getId() ?? '')
        ? 1
        : (b.getId() ?? '') < (a.getId() ?? '')
          ? -1
          : 0;
  });

  // Borrow metadata only from older readable same-sender edits; fall back to own content when no readable edit exists.
  const sources =
    edits.length > 0
      ? edits.map((e) => e.getContent())
      : [applied ? ev.getOriginalContent() : ev.getContent()];
  let aiRun: Record<string, unknown> | undefined;
  let streamStatus: string | undefined;
  for (const content of sources) {
    aiRun ??= getAiRun(content);
    streamStatus ??= getStreamStatus(content);
    if (aiRun && streamStatus) break;
  }
  return { aiRun, streamStatus };
};

const addReplyTokens = (
  usage: Record<string, unknown> | undefined,
  totals: TokenCounts
): number => {
  if (!usage) return 0;
  let added = 0;
  const add = (kind: TokenKind, v: unknown) => {
    const n = asFinite(v);
    if (n !== undefined && n > 0) {
      totals[kind] = (totals[kind] ?? 0) + n;
      added += n;
    }
  };
  const uncached = asFinite(usage.uncached_input_tokens);
  if (uncached === undefined) add('input', usage.input_tokens);
  else {
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
  return added;
};

const extractContext = (
  ctx: Record<string, unknown> | undefined
): ThreadContextUsage | undefined => {
  if (!ctx) return undefined;
  const inputTokens = asFinite(ctx.input_tokens),
    windowTokens = asFinite(ctx.window_tokens),
    rawCache = asFinite(ctx.cache_read_input_tokens);
  if (
    inputTokens === undefined ||
    inputTokens < 0 ||
    windowTokens === undefined ||
    windowTokens <= 0
  )
    return undefined;
  return {
    inputTokens,
    windowTokens,
    percentage: clampContextPercentage((inputTokens / windowTokens) * 100),
    cacheReadTokens:
      rawCache !== undefined && rawCache >= 0 ? Math.min(rawCache, inputTokens) : undefined,
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
  const tokensComplete =
    thread.initialEventsFetched === true &&
    oldest?.getEvents()[0]?.getId() === thread.id &&
    typeof oldest.getPaginationToken(Direction.Backward) !== 'string';

  let totalMicros = 0,
    subagentsMicros = 0,
    pricedReplyCount = 0,
    totalTokensSum = 0,
    tokenReplyCount = 0;
  let unknownCost = false;
  let latestContext: ThreadContextUsage | undefined;
  const tokenCounts: TokenCounts = {};
  const seenModels = new Set<string>();

  for (const ev of events) {
    const eventId = ev.getId();
    if (!eventId || ev.isRedacted() || isReactionOrEdit(ev)) continue;
    const sender = ev.getSender() ?? '';
    if (!isTrustedAgent(sender, viewerId) || isUserIgnored?.(sender)) continue;

    const { aiRun, streamStatus } = resolveReplyMetadata(thread, ev, eventId);
    const cost = isRecord(aiRun?.cost) ? aiRun.cost : undefined;
    const costUsd = asDecimal(cost?.usd);
    const subUsd = asDecimal(cost?.subagents_usd);
    const runStatus = typeof aiRun?.status === 'string' ? aiRun.status.toLowerCase() : undefined;
    if (
      costUsd === undefined &&
      ((runStatus && UNKNOWN_COST_ENDINGS.has(runStatus)) ||
        (streamStatus && UNKNOWN_COST_ENDINGS.has(streamStatus)))
    )
      unknownCost = true;
    if (costUsd !== undefined || subUsd !== undefined) {
      const sub = subUsd !== undefined ? Math.round(subUsd * MICROS_PER_USD) : 0;
      totalMicros += (costUsd !== undefined ? Math.round(costUsd * MICROS_PER_USD) : 0) + sub;
      subagentsMicros += sub;
      pricedReplyCount += 1;
    }
    if (!aiRun) continue;

    const replyTokens = addReplyTokens(
      isRecord(aiRun.usage) ? aiRun.usage : undefined,
      tokenCounts
    );
    if (replyTokens > 0) {
      totalTokensSum += replyTokens;
      tokenReplyCount += 1;
    }
    const label = formatModelLabel(isRecord(aiRun.model) ? aiRun.model : undefined);
    if (label) {
      seenModels.delete(label);
      seenModels.add(label);
    }
    const ctx = extractContext(isRecord(aiRun.context) ? aiRun.context : undefined);
    if (ctx) latestContext = ctx;
  }

  const models = [...seenModels].reverse();
  if (!pricedReplyCount && !tokenReplyCount && !models.length && !latestContext) return undefined;
  return {
    totalCostUsd: pricedReplyCount > 0 ? totalMicros / MICROS_PER_USD : undefined,
    subagentsCostUsd: subagentsMicros / MICROS_PER_USD,
    pricedReplyCount,
    totalTokens: tokenReplyCount > 0 ? totalTokensSum : undefined,
    tokenCounts,
    tokenReplyCount,
    models,
    context: latestContext,
    costComplete: tokensComplete && !unknownCost,
    tokensComplete,
  };
}

const getViewerId = (room: Room, mx?: MatrixClient) =>
  room.client?.getUserId?.() ?? (room.myUserId || undefined) ?? mx?.getUserId?.() ?? undefined;
const getIgnored = (room: Room, mx?: MatrixClient): ((u: string) => boolean) | undefined => {
  const src = typeof mx?.isUserIgnored === 'function' ? mx : room.client;
  return typeof src?.isUserIgnored === 'function' ? (u) => src.isUserIgnored(u) : undefined;
};

/** Synchronous check for `threadDetails.shows`. */
export function threadHasUsage(room: Room, threadId: string): boolean {
  return summarizeThreadUsage(room, threadId, getViewerId(room), getIgnored(room)) !== undefined;
}

const sameSummary = (a: ThreadUsageSummary | undefined, b: ThreadUsageSummary | undefined) =>
  a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b));

// Shared per-Room/client multiplexer: <= 1 listener per event type on `room` and `mx` across all cards.
type ThreadChannel = {
  listeners: Set<() => void>;
  dirty: boolean;
  cached?: { viewerId?: string; snapshot?: ThreadUsageSummary };
};
type RoomUsageBus = {
  channels: Map<string, ThreadChannel>;
  stopRoom?: () => void;
  client?: MatrixClient;
  stopClient?: () => void;
};

const roomBuses = new WeakMap<Room, RoomUsageBus>();
const busOf = (room: Room): RoomUsageBus => {
  let bus = roomBuses.get(room);
  if (!bus) {
    bus = { channels: new Map() };
    roomBuses.set(room, bus);
  }
  return bus;
};
const notifyThread = (bus: RoomUsageBus, threadId: string) => {
  const ch = bus.channels.get(threadId);
  if (ch) {
    ch.dirty = true;
    ch.listeners.forEach((fn) => fn());
  }
};
const notifyAll = (bus: RoomUsageBus) => bus.channels.forEach((_, tid) => notifyThread(bus, tid));

// Returns subscribed threadId, `null` when resolved as non-thread/unsubscribed, or `undefined` if unresolved.
const findTargetThread = (
  room: Room,
  bus: RoomUsageBus,
  targetId: string
): string | null | undefined => {
  if (bus.channels.has(targetId)) return targetId;
  const target = room.findEventById?.(targetId);
  if (target) {
    if (target.threadRootId)
      return bus.channels.has(target.threadRootId) ? target.threadRootId : null;
    if (!matchesEnum(target.getType(), EventType.RoomMessageEncrypted)) return null;
  }
  for (const tid of bus.channels.keys()) {
    const th = room.getThread(tid);
    if (
      th &&
      (th.rootEvent?.getId() === targetId ||
        th.findEventById?.(targetId) !== undefined ||
        th.events?.some((e) => e.getId() === targetId) ||
        th.replyToEvent?.getId() === targetId)
    )
      return tid;
  }
  return undefined;
};

const notifyTarget = (
  room: Room,
  bus: RoomUsageBus,
  targetId: string | undefined,
  fallbackAll: boolean
) => {
  const hit = targetId ? findTargetThread(room, bus, targetId) : undefined;
  if (hit) notifyThread(bus, hit);
  else if (hit === undefined && fallbackAll) notifyAll(bus);
};

const routeEvent = (
  room: Room,
  bus: RoomUsageBus,
  ev: MatrixEvent,
  opts?: { timelineThreadId?: string; checkSelf?: boolean; fallbackAll?: boolean }
) => {
  const direct = opts?.timelineThreadId ?? ev.threadRootId;
  if (direct) {
    notifyThread(bus, direct);
    return;
  }
  const id = ev.getId();
  if (id && bus.channels.has(id)) {
    notifyThread(bus, id);
    return;
  }
  const rel = ev.getRelation();
  if (rel?.event_id) {
    if (matchesEnum(rel.rel_type, RelationType.Thread)) {
      notifyThread(bus, rel.event_id);
      return;
    }
    if (matchesEnum(rel.rel_type, RelationType.Replace)) {
      notifyTarget(room, bus, rel.event_id, !!opts?.fallbackAll);
      return;
    }
    if (matchesEnum(rel.rel_type, RelationType.Annotation)) return;
  }
  if (opts?.checkSelf || opts?.fallbackAll) notifyTarget(room, bus, id, !!opts?.fallbackAll);
};

const attachListeners = (room: Room, bus: RoomUsageBus, client: MatrixClient | undefined) => {
  if (!bus.stopRoom && typeof room.on === 'function' && typeof room.off === 'function') {
    const onTimeline = (
      ev: MatrixEvent,
      _r: Room | undefined,
      _s: boolean | undefined,
      _rem: boolean,
      data: { timeline?: EventTimeline } | undefined
    ) =>
      routeEvent(room, bus, ev, {
        timelineThreadId: data?.timeline?.getTimelineSet?.()?.thread?.id,
      });
    const onRedaction = (ev: MatrixEvent, _r: Room, tid?: string) =>
      tid ? notifyThread(bus, tid) : notifyTarget(room, bus, ev.getAssociatedId?.(), true);
    const onReset = (_r: Room | undefined, ts?: EventTimelineSet) =>
      ts?.thread?.id ? notifyThread(bus, ts.thread.id) : notifyAll(bus);
    const onThread = (th: Thread) => notifyThread(bus, th.id);
    const toggleRoom = (m: 'on' | 'off') => {
      room[m](RoomEvent.Timeline, onTimeline);
      room[m](RoomEvent.Redaction, onRedaction);
      room[m](RoomEvent.TimelineReset, onReset);
      THREAD_EVENTS.forEach((ev) => room[m](ev, onThread));
    };
    toggleRoom('on');
    bus.stopRoom = () => {
      toggleRoom('off');
      bus.stopRoom = undefined;
    };
  }
  if (bus.client === client && bus.stopClient) return;
  bus.stopClient?.();
  if (!client || typeof client.on !== 'function' || typeof client.off !== 'function') return;
  const onDecrypted = (ev: MatrixEvent) => {
    if (ev.getRoomId() === room.roomId) routeEvent(room, bus, ev, { fallbackAll: true });
  };
  const onReplaced = (ev: MatrixEvent) => {
    if (ev.getRoomId() === room.roomId) routeEvent(room, bus, ev, { checkSelf: true });
  };
  const onAccountData = (ev: MatrixEvent) => {
    if (ev.getType() === IGNORED_USERS_EVENT) notifyAll(bus);
  };
  const toggleClient = (m: 'on' | 'off') => {
    client[m](MatrixEventEvent.Decrypted, onDecrypted);
    client[m](MatrixEventEvent.Replaced, onReplaced);
    client[m](ClientEvent.AccountData, onAccountData);
  };
  toggleClient('on');
  bus.client = client;
  bus.stopClient = () => {
    toggleClient('off');
    bus.client = undefined;
    bus.stopClient = undefined;
  };
};

const subscribeThread = (
  room: Room,
  mx: MatrixClient | undefined,
  threadId: string,
  fn: () => void
): (() => void) => {
  const bus = busOf(room);
  const ch = bus.channels.get(threadId) ?? { listeners: new Set(), dirty: true };
  bus.channels.set(threadId, ch);
  ch.listeners.add(fn);
  attachListeners(room, bus, mx ?? room.client);
  return () => {
    ch.listeners.delete(fn);
    if (ch.listeners.size > 0) return;
    bus.channels.delete(threadId);
    if (bus.channels.size === 0) {
      bus.stopRoom?.();
      bus.stopClient?.();
    }
  };
};

const readSnapshot = (
  room: Room,
  threadId: string,
  viewerId: string | undefined,
  ignored: ((u: string) => boolean) | undefined,
  prev: ThreadUsageSummary | undefined
): ThreadUsageSummary | undefined => {
  const ch = roomBuses.get(room)?.channels.get(threadId);
  if (ch && !ch.dirty && ch.cached && ch.cached.viewerId === viewerId) return ch.cached.snapshot;
  const next = summarizeThreadUsage(room, threadId, viewerId, ignored);
  const base = ch?.cached ? ch.cached.snapshot : prev;
  const snapshot = sameSummary(base, next) ? base : next;
  if (ch) {
    ch.cached = { viewerId, snapshot };
    ch.dirty = false;
  }
  return snapshot;
};

/** Live hook returning AI run telemetry for `threadId` in `room` via the shared per-Room/client bus. */
export function useThreadUsage(room: Room, threadId: string): ThreadUsageSummary | undefined {
  const mx = useMatrixClient();
  const viewerId = getViewerId(room, mx);
  const ignored = getIgnored(room, mx);
  const lastRef = useRef<ThreadUsageSummary | undefined>(undefined);
  const subscribe = useCallback(
    (notify: () => void) => subscribeThread(room, mx, threadId, notify),
    [room, mx, threadId]
  );
  return useSyncExternalStore(subscribe, () => {
    const next = readSnapshot(room, threadId, viewerId, ignored, lastRef.current);
    lastRef.current = next;
    return next;
  });
}
