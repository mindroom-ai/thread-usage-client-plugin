import {
  createClient,
  Direction,
  EventType,
  MatrixEvent,
  RelationType,
  Room,
  Thread,
} from 'matrix-js-sdk';
import { FeatureSupport } from 'matrix-js-sdk/lib/models/thread';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clampContextPercentage,
  contextSeverity,
  formatCompactTokens,
  formatCostUsd,
  formatExactTokens,
} from './format';
import { summarizeThreadUsage, threadHasUsage } from './threadUsage';

const ROOM_ID = '!dev:example.org';
const VIEWER = '@alice:example.org';
const AGENT = '@mindroom_dev:example.org';
const FOREIGN_AGENT = '@mindroom_dev:other.example';

const makeEvent = (
  id: string,
  sender: string,
  content: Record<string, unknown>,
  ts = 1_700_000_000_000,
  type: string = EventType.RoomMessage
) =>
  new MatrixEvent({
    type,
    event_id: id,
    room_id: ROOM_ID,
    sender,
    origin_server_ts: ts,
    content: { msgtype: 'm.text', body: id, ...content },
  });

const inThread = (event: MatrixEvent, rootId = '$root') =>
  new MatrixEvent({
    ...event.event,
    content: {
      ...event.getContent(),
      'm.relates_to': { rel_type: RelationType.Thread, event_id: rootId },
    },
  });

const makeEdit = (
  id: string,
  targetId: string,
  sender: string,
  newContent: Record<string, unknown>,
  ts: number,
  topExtra: Record<string, unknown> = {}
) =>
  makeEvent(
    id,
    sender,
    {
      body: `* ${id}`,
      'm.new_content': { msgtype: 'm.text', body: id, ...newContent },
      'm.relates_to': { rel_type: RelationType.Replace, event_id: targetId },
      ...topExtra,
    },
    ts
  );

describe('format helpers', () => {
  it('formats USD costs matching MindRoom display rules', () => {
    expect(formatCostUsd(0, 'en')).toBe('$0.00');
    expect(formatCostUsd(-1, 'en')).toBe('$0.00');
    expect(formatCostUsd(0.0035, 'en')).toBe('$0.0035');
    expect(formatCostUsd(0.042, 'en')).toBe('$0.042');
    expect(formatCostUsd(0.08, 'en')).toBe('$0.08');
    expect(formatCostUsd(0.0999, 'en')).toBe('$0.10');
    expect(formatCostUsd(1.42, 'en')).toBe('$1.42');
  });

  it('formats compact tokens and floors lower bounds at displayed precision', () => {
    expect(formatCompactTokens(850, 'en')).toBe('850');
    expect(formatCompactTokens(1_250, 'en')).toBe('1.3k');
    expect(formatCompactTokens(48_000, 'en')).toBe('48k');
    expect(formatCompactTokens(420_000, 'en')).toBe('420k');
    expect(formatCompactTokens(999_999, 'en')).toBe('1M');
    expect(formatCompactTokens(1_200_000, 'en')).toBe('1.2M');
    expect(formatCompactTokens(1_299_999, 'en')).toBe('1.3M');

    // Lower bounds must never round up past what was actually counted.
    expect(formatCompactTokens(999.9, 'en', { lowerBound: true })).toBe('999');
    expect(formatCompactTokens(1_299, 'en', { lowerBound: true })).toBe('1.2k');
    expect(formatCompactTokens(9_990, 'en', { lowerBound: true })).toBe('9.9k');
    expect(formatCompactTokens(48_999, 'en', { lowerBound: true })).toBe('48k');
    expect(formatCompactTokens(999_999, 'en', { lowerBound: true })).toBe('999k');
    expect(formatCompactTokens(1_299_999, 'en', { lowerBound: true })).toBe('1.2M');
    expect(formatExactTokens(420_512, 'en')).toBe('420,512');
  });

  it('clamps context percentage and maps severity bands', () => {
    expect(clampContextPercentage(-5)).toBe(0);
    expect(clampContextPercentage(64)).toBe(64);
    expect(clampContextPercentage(125)).toBe(100);
    expect(contextSeverity(0)).toBe('normal');
    expect(contextSeverity(74.9)).toBe('normal');
    expect(contextSeverity(75)).toBe('warning');
    expect(contextSeverity(89.9)).toBe('warning');
    expect(contextSeverity(90)).toBe('critical');
    expect(contextSeverity(100)).toBe('critical');
  });
});

describe('summarizeThreadUsage', () => {
  let prevSupport: FeatureSupport;

  beforeEach(() => {
    prevSupport = Thread.hasServerSideSupport;
    Thread.hasServerSideSupport = FeatureSupport.Stable;
  });

  afterEach(() => {
    Thread.hasServerSideSupport = prevSupport;
    vi.restoreAllMocks();
  });

  const createFixture = async (
    replies: MatrixEvent[],
    { fetched = true, rootSender = VIEWER, rootExtra = {} } = {}
  ) => {
    const client = createClient({ baseUrl: 'https://example.org', userId: VIEWER });
    vi.spyOn(client, 'supportsThreads').mockReturnValue(true);
    const root = makeEvent('$root', rootSender, rootExtra, 1_700_000_000_000);
    vi.spyOn(client.http, 'authedRequest').mockImplementation(async (_method, path) =>
      path.includes('/event/') ? root.event : { chunk: [] }
    );
    const room = new Room(ROOM_ID, client, VIEWER);
    client.store.storeRoom(room);
    room.getUnfilteredTimelineSet().addLiveEvent(root, { addToState: false });
    const thread = room.createThread('$root', root, [], false);
    if (fetched) await thread.initialize();
    thread.addEvents(replies.map((ev) => inThread(ev)), false);
    if (replies.length > 0) {
      await vi.waitFor(() => expect(thread.events.length).toBeGreaterThanOrEqual(replies.length));
    }
    return { client, room, thread, root };
  };

  it('returns undefined for missing, human-only, spoofed, ignored, or redacted threads', async () => {
    const redacted = makeEvent('$redacted', AGENT, {
      'io.mindroom.ai_run': { version: 1, status: 'completed', cost: { usd: '0.50' } },
    });
    const { room, thread } = await createFixture([
      makeEvent('$human', VIEWER, {
        'io.mindroom.ai_run': { version: 1, status: 'completed', cost: { usd: '9.99' } },
      }),
      makeEvent('$spoof', FOREIGN_AGENT, {
        'io.mindroom.ai_run': { version: 1, status: 'completed', cost: { usd: '9.99' } },
      }),
      redacted,
      new MatrixEvent({
        type: EventType.Reaction,
        event_id: '$rx',
        room_id: ROOM_ID,
        sender: AGENT,
        content: {
          'm.relates_to': { rel_type: RelationType.Annotation, event_id: '$root', key: '👍' },
          'io.mindroom.ai_run': { version: 1, status: 'completed', cost: { usd: '1.00' } },
        },
      }),
    ]);

    thread.findEventById('$redacted')?.makeRedacted(
      new MatrixEvent({ type: EventType.RoomRedaction, event_id: '$red', sender: VIEWER, content: {} }),
      room
    );
    expect(summarizeThreadUsage(room, '$missing', VIEWER)).toBeUndefined();
    expect(summarizeThreadUsage(room, '$root', VIEWER)).toBeUndefined();
    expect(threadHasUsage(room, '$root')).toBe(false);

    const { room: ignoredRoom } = await createFixture([
      makeEvent('$r1', AGENT, {
        'io.mindroom.ai_run': { version: 1, status: 'completed', cost: { usd: '0.10' } },
      }),
    ]);
    expect(summarizeThreadUsage(ignoredRoom, '$root', VIEWER, (id) => id === AGENT)).toBeUndefined();
  });

  it('sums micro-dollars + subagents, token breakdown, model recency, and latest clamped context', async () => {
    const { room } = await createFixture([
      makeEvent('$r1', AGENT, {
        'io.mindroom.ai_run': {
          version: 1,
          status: 'completed',
          model: { id: 'anthropic/claude-sonnet-5.5', display_name: ' Sonnet 5.5 ' },
          cost: { usd: '0.1', subagents_usd: '0.25' },
          usage: {
            cache_read_tokens: 100_000,
            uncached_input_tokens: 30_000,
            cache_write_tokens: 20_000,
            output_tokens: 10_000,
          },
          context: { input_tokens: 80_000, window_tokens: 200_000 },
        },
      }),
      makeEvent('$r2', AGENT, {
        'io.mindroom.ai_run': {
          version: 1,
          status: 'completed',
          model: { id: 'openrouter/openai/gpt-6.2-astra' },
          cost: { usd: 0.2, subagents_usd: '0.09' },
          usage: {
            cache_read_tokens: 50_000,
            uncached_input_tokens: 15_000,
            output_tokens: 5_000,
          },
          context: {
            input_tokens: 220_000,
            window_tokens: 200_000,
            cache_read_input_tokens: 250_000,
          },
        },
      }),
      makeEvent('$r3', AGENT, {
        'io.mindroom.ai_run': {
          version: 1,
          status: 'completed',
          model: { config: 'fast-local' },
          usage: { input_tokens: 4_000, output_tokens: 1_000 },
        },
      }),
      makeEvent('$r4', AGENT, {
        'io.mindroom.ai_run': {
          version: 1,
          status: 'completed',
          model: { display_name: 'Sonnet 5.5' },
        },
      }),
    ]);

    const summary = summarizeThreadUsage(room, '$root', VIEWER);
    expect(summary).toBeDefined();
    expect(summary?.totalCostUsd).toBe(0.64);
    expect(summary?.subagentsCostUsd).toBe(0.34);
    expect(summary?.pricedReplyCount).toBe(2);
    expect(summary?.tokenCounts).toEqual({
      cacheRead: 150_000,
      cacheWrite: 20_000,
      notCached: 10_000,
      newInput: 15_000,
      input: 4_000,
      output: 16_000,
    });
    expect(summary?.totalTokens).toBe(215_000);
    expect(summary?.tokenReplyCount).toBe(3);
    // Most recently used first, deduplicated: Sonnet 5.5 was reused in $r4.
    expect(summary?.models).toEqual(['Sonnet 5.5', 'fast-local', 'gpt-6.2-astra']);
    // Context from latest reply that carried valid context ($r2), clamped cleanly.
    expect(summary?.context).toEqual({
      inputTokens: 220_000,
      windowTokens: 200_000,
      percentage: 100,
      cacheReadTokens: 220_000,
      uncachedTokens: 0,
    });
    expect(summary?.historyComplete).toBe(true);
    expect(summary?.costComplete).toBe(true);
    expect(summary?.complete).toBe(true);
    expect(summary?.tokensComplete).toBe(true);
    expect(threadHasUsage(room, '$root')).toBe(true);
  });

  it.each(['cancelled', 'error', 'interrupted'])(
    'marks costComplete false when a %s reply lacks cost.usd',
    async (status) => {
      const { room } = await createFixture([
        makeEvent('$r1', AGENT, {
          'io.mindroom.ai_run': { version: 1, status: 'completed', cost: { usd: '0.08' } },
        }),
        makeEvent('$r2', AGENT, {
          'io.mindroom.ai_run': { version: 1, status, cost: { subagents_usd: '0.02' } },
        }),
      ]);
      const summary = summarizeThreadUsage(room, '$root', VIEWER);
      expect(summary?.totalCostUsd).toBe(0.1);
      expect(summary?.historyComplete).toBe(true);
      expect(summary?.tokensComplete).toBe(true);
      expect(summary?.costComplete).toBe(false);
      expect(summary?.complete).toBe(false);
    }
  );

  it('walks linked older timelines and tracks partial vs complete history flags', async () => {
    const { room, thread, root } = await createFixture(
      [
        makeEvent('$new', AGENT, {
          'io.mindroom.ai_run': {
            version: 1,
            status: 'completed',
            cost: { usd: '0.50' },
            usage: { input_tokens: 10_000, output_tokens: 2_000 },
          },
        }),
      ],
      { fetched: false }
    );
    expect(summarizeThreadUsage(room, '$root', VIEWER)?.historyComplete).toBe(false);

    thread.initialEventsFetched = true;
    const ts = thread.getUnfilteredTimelineSet();
    const live = ts.getLiveTimeline();
    const older = ts.addTimeline();
    const oldReply = inThread(
      makeEvent('$old', AGENT, {
        'io.mindroom.ai_run': {
          version: 1,
          status: 'completed',
          cost: { usd: '0.25' },
          usage: { input_tokens: 30_000, output_tokens: 6_000 },
        },
      })
    );
    ts.addEventToTimeline(root, older, { toStartOfTimeline: false, addToState: false });
    ts.addEventToTimeline(oldReply, older, { toStartOfTimeline: false, addToState: false });
    older.setPaginationToken('prev-page', Direction.Backward);
    older.setNeighbouringTimeline(live, Direction.Forward);
    live.setNeighbouringTimeline(older, Direction.Backward);

    const partial = summarizeThreadUsage(room, '$root', VIEWER);
    expect(partial?.totalCostUsd).toBe(0.75);
    expect(partial?.totalTokens).toBe(48_000);
    expect(partial?.historyComplete).toBe(false);
    expect(partial?.tokensComplete).toBe(false);

    older.setPaginationToken(null, Direction.Backward);
    const complete = summarizeThreadUsage(room, '$root', VIEWER);
    expect(complete?.historyComplete).toBe(true);
    expect(complete?.costComplete).toBe(true);
    expect(complete?.tokensComplete).toBe(true);
  });

  it('resolves latest readable same-sender m.replace edit and borrows ai_run metadata', async () => {
    const original = makeEvent(
      '$r1',
      AGENT,
      {
        'io.mindroom.ai_run': { version: 1, status: 'completed', cost: { usd: '0.01' } },
      },
      1_000
    );
    const original2 = makeEvent(
      '$r2',
      AGENT,
      {
        'io.mindroom.ai_run': { version: 1, status: 'completed', cost: { usd: '0.04' } },
      },
      1_500
    );
    const { room, thread } = await createFixture([original, original2]);

    const olderAiEdit = makeEdit(
      '$e1',
      '$r1',
      AGENT,
      { body: 'final answer' },
      2_000,
      // Top-level io.mindroom.ai_run fallback when m.new_content omits it.
      { 'io.mindroom.ai_run': { version: 1, status: 'completed', cost: { usd: '0.40' }, model: { display_name: 'Opus 5.5' } } }
    );
    const newerTextOnlyEdit = makeEdit('$e2', '$r1', AGENT, { body: 'typo fix' }, 3_000);
    const spoofedEdit = makeEdit(
      '$e3',
      '$r1',
      VIEWER,
      { 'io.mindroom.ai_run': { version: 1, status: 'completed', cost: { usd: '99.00' } } },
      4_000
    );
    const redactedEdit = makeEdit(
      '$e4',
      '$r1',
      AGENT,
      { 'io.mindroom.ai_run': { version: 1, status: 'completed', cost: { usd: '77.00' } } },
      5_000
    );
    redactedEdit.makeRedacted(
      new MatrixEvent({ type: EventType.RoomRedaction, event_id: '$red2', sender: AGENT, content: {} }),
      room
    );
    const rel = thread.timelineSet.relations;
    [olderAiEdit, newerTextOnlyEdit, spoofedEdit, redactedEdit].forEach((ev) => rel.aggregateChildEvent(ev));

    // For $r2, apply a text-only replacingEvent directly on the event -> falls back to original content.
    const r2InThread = thread.findEventById('$r2')!;
    const r2Edit = makeEdit('$e5', '$r2', AGENT, { body: 'edited r2' }, 3_500);
    r2InThread.makeReplaced(r2Edit);

    const summary = summarizeThreadUsage(room, '$root', VIEWER);
    expect(summary?.totalCostUsd).toBe(0.44);
    expect(summary?.models).toEqual(['Opus 5.5']);
  });
});
