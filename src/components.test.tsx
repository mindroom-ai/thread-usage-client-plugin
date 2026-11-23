// @vitest-environment jsdom
import { act } from 'react-dom/test-utils';
import {
  createClient,
  EventType,
  MatrixEvent,
  RelationType,
  Room,
  RoomEvent,
  Thread,
  ThreadEvent,
} from 'matrix-js-sdk';
import { FeatureSupport } from 'matrix-js-sdk/lib/models/thread';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import plugin from './index';
import { ThreadCardUsage } from './ThreadCardUsage';
import { ThreadUsageDetails } from './ThreadUsageDetails';
import { PLUGIN_ID, threadHasUsage } from './threadUsage';

const ROOM_ID = '!ops:example.org';
const VIEWER = '@alice:example.org';
const AGENT = '@mindroom_dev:example.org';

const msg = (id: string, sender: string, content: Record<string, unknown>, ts = 1_700_000_000_000) =>
  new MatrixEvent({
    type: EventType.RoomMessage,
    event_id: id,
    room_id: ROOM_ID,
    sender,
    origin_server_ts: ts,
    content: { msgtype: 'm.text', body: id, ...content },
  });

const replyIn = (rootId: string, event: MatrixEvent) =>
  new MatrixEvent({
    ...event.event,
    content: {
      ...event.getContent(),
      'm.relates_to': { rel_type: RelationType.Thread, event_id: rootId },
    },
  });

describe('ThreadCardUsage, ThreadUsageDetails, and room event multiplexer', () => {
  let prevSupport: FeatureSupport;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    prevSupport = Thread.hasServerSideSupport;
    Thread.hasServerSideSupport = FeatureSupport.Stable;
  });

  afterEach(() => {
    Thread.hasServerSideSupport = prevSupport;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const createRoom = () => {
    const client = createClient({ baseUrl: 'https://example.org', userId: VIEWER });
    vi.spyOn(client, 'supportsThreads').mockReturnValue(true);
    const room = new Room(ROOM_ID, client, VIEWER);
    client.store.storeRoom(room);
    return { client, room };
  };

  const addThread = async (
    client: ReturnType<typeof createClient>,
    room: Room,
    rootId: string,
    replies: MatrixEvent[],
    fetched = true
  ) => {
    const root = msg(rootId, VIEWER, {});
    vi.spyOn(client.http, 'authedRequest').mockImplementation(async (_method, path) =>
      path.includes(`/event/${encodeURIComponent(rootId)}`) ? root.event : { chunk: [] }
    );
    room.getUnfilteredTimelineSet().addLiveEvent(root, { addToState: false });
    const thread = room.createThread(rootId, root, [], false);
    if (fetched) await thread.initialize();
    if (replies.length > 0) {
      thread.addEvents(replies.map((ev) => replyIn(rootId, ev)), false);
      await vi.waitFor(() => expect(thread.events.length).toBeGreaterThanOrEqual(replies.length));
    }
    return thread;
  };

  it('renders quiet Option B strip with config toggles and zero interactive controls', async () => {
    const { client, room } = createRoom();
    await addThread(client, room, '$t1', [
      msg('$r1', AGENT, {
        'io.mindroom.ai_run': {
          version: 1,
          status: 'completed',
          model: { display_name: 'Sonnet 5.5' },
          cost: { usd: '0.42', subagents_usd: '0.18' },
          usage: { cache_read_tokens: 180_000, uncached_input_tokens: 30_000, output_tokens: 10_000 },
          context: { input_tokens: 60_000, window_tokens: 200_000 },
        },
      }),
      msg('$r2', AGENT, {
        'io.mindroom.ai_run': {
          version: 1,
          status: 'completed',
          model: { display_name: 'Opus 5.5' },
          cost: { usd: '0.66', subagents_usd: '0.16' },
          usage: { cache_read_tokens: 140_000, uncached_input_tokens: 40_000, output_tokens: 20_000 },
          context: { input_tokens: 128_000, window_tokens: 200_000, cache_read_input_tokens: 96_000 },
        },
      }),
    ]);

    const { container, unmount } = await renderPluginComponent(
      <ThreadCardUsage room={room} threadId="$t1" />,
      { id: PLUGIN_ID, plugin, client }
    );
    const strip = container.querySelector('.mrtu-card-strip');
    expect(strip).not.toBeNull();
    expect(strip?.textContent).toBe('$1.42·420k·Opus 5.5 +1·64%');
    expect(container.querySelector('[data-usage-severity="normal"]')).not.toBeNull();
    expect(container.querySelectorAll('button, a, [tabindex]')).toHaveLength(0);
    unmount();

    // Config toggles hide selected segments without affecting the rest.
    const { container: toggled } = await renderPluginComponent(
      <ThreadCardUsage room={room} threadId="$t1" />,
      {
        id: PLUGIN_ID,
        plugin,
        client,
        config: { showTokens: false, showModels: false },
      }
    );
    expect(toggled.querySelector('.mrtu-card-strip')?.textContent).toBe('$1.42·64%');
  });

  it('renders lower-bound prefixes on partial history and warning/critical context rings', async () => {
    const { client, room } = createRoom();
    await addThread(
      client,
      room,
      '$partial',
      [
        msg('$p1', AGENT, {
          'io.mindroom.ai_run': {
            version: 1,
            status: 'completed',
            cost: { usd: '0.08' },
            usage: { input_tokens: 48_900 },
            context: { input_tokens: 184_000, window_tokens: 200_000 },
          },
        }),
      ],
      false
    );

    const { container } = await renderPluginComponent(
      <ThreadCardUsage room={room} threadId="$partial" />,
      { id: PLUGIN_ID, plugin, client }
    );
    expect(container.querySelector('[data-usage-cost]')?.textContent).toBe('≥ $0.08');
    expect(container.querySelector('[data-usage-tokens]')?.textContent).toBe('≥ 48k');
    expect(container.querySelector('[data-usage-context]')?.getAttribute('data-usage-severity')).toBe(
      'critical'
    );
  });

  it('renders read-only ThreadUsageDetails with subagents, breakdown, models, and 2-part context bar', async () => {
    const { client, room } = createRoom();
    await addThread(
      client,
      room,
      '$det',
      [
        msg('$d1', AGENT, {
          'io.mindroom.ai_run': {
            version: 1,
            status: 'completed',
            model: { display_name: 'Sonnet 5.5' },
            cost: { usd: '0.50', subagents_usd: '0.34' },
            usage: {
              cache_read_tokens: 280_000,
              uncached_input_tokens: 90_000,
              cache_write_tokens: 40_000,
              output_tokens: 50_000,
            },
            context: { input_tokens: 128_000, window_tokens: 200_000, cache_read_input_tokens: 96_000 },
          },
        }),
        msg('$d2', AGENT, {
          'io.mindroom.ai_run': {
            version: 1,
            status: 'cancelled',
            model: { display_name: 'Opus 5.5' },
          },
        }),
      ],
      true
    );

    expect(plugin.threadDetails?.[0]?.shows?.(room, '$det')).toBe(true);
    expect(threadHasUsage(room, '$missing')).toBe(false);

    const { container, getByText } = await renderPluginComponent(
      <ThreadUsageDetails room={room} threadId="$det" />,
      { id: PLUGIN_ID, plugin, client }
    );
    expect(container.querySelector('[data-thread-usage-details]')).not.toBeNull();
    expect(getByText('At least $0.84')).toBeTruthy();
    expect(getByText('+$0.34 subagents')).toBeTruthy();
    expect(getByText('420,000')).toBeTruthy();
    expect(getByText('280k cached · 40k write · 50k uncached · 50k out')).toBeTruthy();
    expect(getByText('Opus 5.5, Sonnet 5.5')).toBeTruthy();
    expect(container.querySelector('[data-usage-detail="context"]')?.textContent).toContain(
      '128k / 200k · 64%'
    );
    expect(container.querySelector('.mrtu-bar-cached')).not.toBeNull();
    expect(container.querySelector('.mrtu-bar-uncached')).not.toBeNull();
    expect(container.querySelectorAll('button, a, [tabindex]')).toHaveLength(0);
  });

  it('multiplexes 25 mounted cards onto <=1 room listener per event, updates live, and cleans up', async () => {
    const { client, room } = createRoom();
    const ids = Array.from({ length: 25 }, (_, i) => `$card_${i}`);
    for (const id of ids) {
      await addThread(client, room, id, [
        msg(`${id}_r1`, AGENT, {
          'io.mindroom.ai_run': { version: 1, status: 'completed', cost: { usd: '0.10' } },
        }),
      ]);
    }

    const baseTimeline = room.listenerCount(RoomEvent.Timeline);
    const baseRedaction = room.listenerCount(RoomEvent.Redaction);
    const baseReset = room.listenerCount(RoomEvent.TimelineReset);
    const baseUpdate = room.listenerCount(ThreadEvent.Update);
    const baseNewReply = room.listenerCount(ThreadEvent.NewReply);

    const { container, unmount } = await renderPluginComponent(
      <div>
        {ids.map((id) => (
          <div key={id} data-card={id}>
            <ThreadCardUsage room={room} threadId={id} />
          </div>
        ))}
      </div>,
      { id: PLUGIN_ID, plugin, client }
    );

    expect(room.listenerCount(RoomEvent.Timeline) - baseTimeline).toBe(1);
    expect(room.listenerCount(RoomEvent.Redaction) - baseRedaction).toBe(1);
    expect(room.listenerCount(RoomEvent.TimelineReset) - baseReset).toBe(1);
    expect(room.listenerCount(ThreadEvent.Update) - baseUpdate).toBe(1);
    expect(room.listenerCount(ThreadEvent.NewReply) - baseNewReply).toBe(1);

    // Live reply updates only the affected thread card.
    const firstThread = room.getThread('$card_0')!;
    await act(async () => {
      firstThread.addEvents(
        [
          replyIn(
            '$card_0',
            msg('$card_0_r2', AGENT, {
              'io.mindroom.ai_run': { version: 1, status: 'completed', cost: { usd: '0.25' } },
            })
          ),
        ],
        false
      );
      firstThread.emit(ThreadEvent.Update, firstThread);
    });
    expect(container.querySelector('[data-card="$card_0"] [data-usage-cost]')?.textContent).toBe(
      '$0.35'
    );
    expect(container.querySelector('[data-card="$card_1"] [data-usage-cost]')?.textContent).toBe(
      '$0.10'
    );

    // Live m.replace edit arriving via RoomEvent.Timeline updates the targeted thread card.
    const editEv = msg(
      '$card_0_edit',
      AGENT,
      {
        'm.new_content': {
          msgtype: 'm.text',
          body: 'edited',
          'io.mindroom.ai_run': { version: 1, status: 'completed', cost: { usd: '0.50' } },
        },
        'm.relates_to': { rel_type: RelationType.Replace, event_id: '$card_0_r2' },
      },
      1_700_000_010_000
    );
    await act(async () => {
      firstThread.timelineSet.relations.aggregateChildEvent(editEv);
      room.emit(RoomEvent.Timeline, editEv, room, false, false, {
        liveEvent: true,
        timeline: room.getLiveTimeline(),
      });
    });
    expect(container.querySelector('[data-card="$card_0"] [data-usage-cost]')?.textContent).toBe(
      '$0.60'
    );

    // Live redaction arriving via RoomEvent.Redaction drops the redacted reply's cost.
    const redactionEv = new MatrixEvent({
      type: EventType.RoomRedaction,
      event_id: '$card_0_red',
      room_id: ROOM_ID,
      sender: VIEWER,
      redacts: '$card_0_r2',
      content: {},
    });
    await act(async () => {
      firstThread.findEventById('$card_0_r2')?.makeRedacted(redactionEv, room);
      room.emit(RoomEvent.Redaction, redactionEv, room, '$card_0');
    });
    expect(container.querySelector('[data-card="$card_0"] [data-usage-cost]')?.textContent).toBe(
      '$0.10'
    );

    unmount();
    expect(room.listenerCount(RoomEvent.Timeline) - baseTimeline).toBe(0);
    expect(room.listenerCount(RoomEvent.Redaction) - baseRedaction).toBe(0);
    expect(room.listenerCount(RoomEvent.TimelineReset) - baseReset).toBe(0);
    expect(room.listenerCount(ThreadEvent.Update) - baseUpdate).toBe(0);
    expect(room.listenerCount(ThreadEvent.NewReply) - baseNewReply).toBe(0);
  });
});
