// @vitest-environment jsdom
import { act } from 'react-dom/test-utils';
import {
  ClientEvent,
  createClient,
  EventType,
  MatrixEvent,
  MatrixEventEvent,
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

const msg = (
  id: string,
  sender: string,
  content: Record<string, unknown>,
  ts = 1_700_000_000_000
) =>
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
      thread.addEvents(
        replies.map((ev) => replyIn(rootId, ev)),
        false
      );
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
          usage: {
            cache_read_tokens: 180_000,
            uncached_input_tokens: 30_000,
            output_tokens: 10_000,
          },
          context: { input_tokens: 60_000, window_tokens: 200_000 },
        },
      }),
      msg('$r2', AGENT, {
        'io.mindroom.ai_run': {
          version: 1,
          status: 'completed',
          model: { display_name: 'Opus 5.5' },
          cost: { usd: '0.66', subagents_usd: '0.16' },
          usage: {
            cache_read_tokens: 140_000,
            uncached_input_tokens: 40_000,
            output_tokens: 20_000,
          },
          context: {
            input_tokens: 128_000,
            window_tokens: 200_000,
            cache_read_input_tokens: 96_000,
          },
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
    const { container: toggled, unmount: unmountToggled } = await renderPluginComponent(
      <ThreadCardUsage room={room} threadId="$t1" />,
      {
        id: PLUGIN_ID,
        plugin,
        client,
        config: { showTokens: false, showModels: false },
      }
    );
    expect(toggled.querySelector('.mrtu-card-strip')?.textContent).toBe('$1.42·64%');
    unmountToggled();

    // On phones, condense to the two highest-signal segments (cost + context ring) so the strip fits.
    const { container: phone, unmount: unmountPhone } = await renderPluginComponent(
      <ThreadCardUsage room={room} threadId="$t1" />,
      { id: PLUGIN_ID, plugin, client, screenSize: 'Mobile' }
    );
    expect(phone.querySelector('.mrtu-card-strip')?.textContent).toBe('$1.42·64%');
    unmountPhone();

    // When cost is toggled off on a phone, fall back to tokens + context.
    const { container: phoneFallback } = await renderPluginComponent(
      <ThreadCardUsage room={room} threadId="$t1" />,
      { id: PLUGIN_ID, plugin, client, screenSize: 'Mobile', config: { showCost: false } }
    );
    expect(phoneFallback.querySelector('.mrtu-card-strip')?.textContent).toBe('420k·64%');
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

    const { container, unmount } = await renderPluginComponent(
      <ThreadCardUsage room={room} threadId="$partial" />,
      { id: PLUGIN_ID, plugin, client }
    );
    expect(container.querySelector('[data-usage-cost]')?.textContent).toBe('≥ $0.08');
    expect(container.querySelector('[data-usage-tokens]')?.textContent).toBe('≥ 48k');
    expect(
      container.querySelector('[data-usage-context]')?.getAttribute('data-usage-severity')
    ).toBe('critical');
    unmount();

    // Lower-bound costs floor downward on both card and details ($1.236 -> $1.23, $0.0429 -> $0.042).
    await addThread(
      client,
      room,
      '$floorHigh',
      [
        msg('$fh1', AGENT, {
          'io.mindroom.ai_run': { version: 1, status: 'completed', cost: { usd: '1.236' } },
        }),
      ],
      false
    );
    await addThread(
      client,
      room,
      '$floorLow',
      [
        msg('$fl1', AGENT, {
          'io.mindroom.ai_run': { version: 1, status: 'completed', cost: { usd: '0.0429' } },
        }),
      ],
      false
    );
    const { container: floorView } = await renderPluginComponent(
      <div>
        <div data-floor="high">
          <ThreadCardUsage room={room} threadId="$floorHigh" />
          <ThreadUsageDetails room={room} threadId="$floorHigh" />
        </div>
        <div data-floor="low">
          <ThreadCardUsage room={room} threadId="$floorLow" />
          <ThreadUsageDetails room={room} threadId="$floorLow" />
        </div>
      </div>,
      { id: PLUGIN_ID, plugin, client }
    );
    expect(floorView.querySelector('[data-floor="high"] [data-usage-cost]')?.textContent).toBe(
      '≥ $1.23'
    );
    expect(
      floorView.querySelector('[data-floor="high"] [data-usage-detail="cost"]')?.textContent
    ).toContain('At least $1.23');
    expect(floorView.querySelector('[data-floor="low"] [data-usage-cost]')?.textContent).toBe(
      '≥ $0.042'
    );
    expect(
      floorView.querySelector('[data-floor="low"] [data-usage-detail="cost"]')?.textContent
    ).toContain('At least $0.042');
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
            context: {
              input_tokens: 128_000,
              window_tokens: 200_000,
              cache_read_input_tokens: 96_000,
            },
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
    expect(container.querySelector('[data-usage-context-breakdown]')?.textContent).toBe(
      '96k cached · 32k new'
    );
    expect(container.querySelector('.mrtu-bar-cached')).not.toBeNull();
    expect(container.querySelector('.mrtu-bar-uncached')).not.toBeNull();
    expect(container.querySelectorAll('button, a, [tabindex]')).toHaveLength(0);
  });

  it('handles cached-only/zero-cache context breakdown, rounded severity thresholds, and signed-out clients', async () => {
    const { client, room } = createRoom();
    await addThread(client, room, '$allCached', [
      msg('$ac1', AGENT, {
        'io.mindroom.ai_run': {
          version: 1,
          status: 'completed',
          context: {
            input_tokens: 104_000,
            window_tokens: 200_000,
            cache_read_input_tokens: 104_000,
          },
        },
      }),
    ]);
    await addThread(client, room, '$zeroCache', [
      msg('$zc1', AGENT, {
        'io.mindroom.ai_run': {
          version: 1,
          status: 'completed',
          context: { input_tokens: 149_200, window_tokens: 200_000, cache_read_input_tokens: 0 },
        },
      }),
    ]);
    await addThread(client, room, '$critRound', [
      msg('$cr1', AGENT, {
        'io.mindroom.ai_run': {
          version: 1,
          status: 'completed',
          context: { input_tokens: 179_200, window_tokens: 200_000 },
        },
      }),
    ]);

    const { container, unmount } = await renderPluginComponent(
      <div>
        <div data-case="allCached">
          <ThreadUsageDetails room={room} threadId="$allCached" />
        </div>
        <div data-case="zeroCache">
          <ThreadCardUsage room={room} threadId="$zeroCache" />
          <ThreadUsageDetails room={room} threadId="$zeroCache" />
        </div>
        <div data-case="critRound">
          <ThreadCardUsage room={room} threadId="$critRound" />
          <ThreadUsageDetails room={room} threadId="$critRound" />
        </div>
      </div>,
      { id: PLUGIN_ID, plugin, client }
    );
    expect(
      container.querySelector('[data-case="allCached"] [data-usage-context-breakdown]')?.textContent
    ).toBe('104k cached');
    expect(
      container.querySelector('[data-case="zeroCache"] [data-usage-context-breakdown]')
    ).toBeNull();
    // 74.6% rounds to 75% -> warning on both card and details.
    expect(
      container.querySelector('[data-case="zeroCache"] [data-usage-context]')?.textContent
    ).toBe('75%');
    expect(
      container
        .querySelector('[data-case="zeroCache"] [data-usage-context]')
        ?.getAttribute('data-usage-severity')
    ).toBe('warning');
    expect(
      container.querySelector(
        '[data-case="zeroCache"] [data-usage-detail="context"] .mrtu-severity-warning'
      )?.textContent
    ).toBe('75%');
    // 89.6% rounds to 90% -> critical on both card and details.
    expect(
      container.querySelector('[data-case="critRound"] [data-usage-context]')?.textContent
    ).toBe('90%');
    expect(
      container
        .querySelector('[data-case="critRound"] [data-usage-context]')
        ?.getAttribute('data-usage-severity')
    ).toBe('critical');
    expect(
      container.querySelector(
        '[data-case="critRound"] [data-usage-detail="context"] .mrtu-severity-critical'
      )?.textContent
    ).toBe('90%');
    unmount();

    // Signed-out MatrixClient (getUserId() === null, getSafeUserId() throws) does not throw in useThreadUsage.
    const signedOutClient = createClient({ baseUrl: 'https://example.org' });
    const signedOutRoom = new Room(ROOM_ID, signedOutClient, '');
    vi.spyOn(client, 'getSafeUserId')
      .mockReturnValueOnce(VIEWER)
      .mockImplementation(() => {
        throw new Error('Expected logged in user but found none.');
      });
    vi.spyOn(client, 'getUserId').mockReturnValue(null);
    const { container: signedOut } = await renderPluginComponent(
      <div>
        <ThreadCardUsage room={signedOutRoom} threadId="$t" />
        <ThreadUsageDetails room={signedOutRoom} threadId="$t" />
      </div>,
      { id: PLUGIN_ID, plugin, client }
    );
    expect(signedOut.querySelector('[data-thread-usage-card]')).toBeNull();
    expect(signedOut.querySelector('[data-thread-usage-details]')).toBeNull();
  });

  it('multiplexes 25 mounted cards onto <=1 room & client listener per event, updates live, and cleans up', async () => {
    const { client, room } = createRoom();
    const ids = Array.from({ length: 25 }, (_, i) => `$card_${i}`);
    for (const id of ids) {
      await addThread(client, room, id, [
        msg(`${id}_r1`, AGENT, {
          'io.mindroom.ai_run': { version: 1, status: 'completed', cost: { usd: '0.10' } },
        }),
      ]);
    }
    const firstThread = room.getThread('$card_0')!;

    const baseRoom = {
      timeline: room.listenerCount(RoomEvent.Timeline),
      redaction: room.listenerCount(RoomEvent.Redaction),
      reset: room.listenerCount(RoomEvent.TimelineReset),
      threadNew: room.listenerCount(ThreadEvent.New),
      update: room.listenerCount(ThreadEvent.Update),
      newReply: room.listenerCount(ThreadEvent.NewReply),
      threadDelete: room.listenerCount(ThreadEvent.Delete),
    };
    const baseClient = {
      decrypted: client.listenerCount(MatrixEventEvent.Decrypted),
      replaced: client.listenerCount(MatrixEventEvent.Replaced),
      accountData: client.listenerCount(ClientEvent.AccountData),
    };
    const baseThreadUpdate = firstThread.listenerCount(ThreadEvent.Update);
    const baseThreadNewReply = firstThread.listenerCount(ThreadEvent.NewReply);

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

    expect(room.listenerCount(RoomEvent.Timeline) - baseRoom.timeline).toBe(1);
    expect(room.listenerCount(RoomEvent.Redaction) - baseRoom.redaction).toBe(1);
    expect(room.listenerCount(RoomEvent.TimelineReset) - baseRoom.reset).toBe(1);
    expect(room.listenerCount(ThreadEvent.New) - baseRoom.threadNew).toBe(1);
    expect(room.listenerCount(ThreadEvent.Update) - baseRoom.update).toBe(1);
    expect(room.listenerCount(ThreadEvent.NewReply) - baseRoom.newReply).toBe(1);
    expect(room.listenerCount(ThreadEvent.Delete) - baseRoom.threadDelete).toBe(1);
    expect(client.listenerCount(MatrixEventEvent.Decrypted) - baseClient.decrypted).toBe(1);
    expect(client.listenerCount(MatrixEventEvent.Replaced) - baseClient.replaced).toBe(1);
    expect(client.listenerCount(ClientEvent.AccountData) - baseClient.accountData).toBe(1);
    // No redundant per-thread listeners are attached.
    expect(firstThread.listenerCount(ThreadEvent.Update)).toBe(baseThreadUpdate);
    expect(firstThread.listenerCount(ThreadEvent.NewReply)).toBe(baseThreadNewReply);

    // Live reply updates only the affected thread card.
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

    // Unrelated main-timeline m.replace edit short-circuits without scanning all 25 threads.
    const mainMsg = msg('$main_msg', VIEWER, { body: 'plain room msg' });
    room.getUnfilteredTimelineSet().addLiveEvent(mainMsg, { addToState: false });
    const getThreadSpy = vi.spyOn(room, 'getThread');
    const mainEdit = msg('$main_edit', VIEWER, {
      'm.new_content': { msgtype: 'm.text', body: 'edited main' },
      'm.relates_to': { rel_type: RelationType.Replace, event_id: '$main_msg' },
    });
    await act(async () => {
      room.emit(RoomEvent.Timeline, mainEdit, room, false, false, {
        liveEvent: true,
        timeline: room.getLiveTimeline(),
      });
    });
    expect(getThreadSpy).not.toHaveBeenCalled();
    getThreadSpy.mockRestore();

    // Live MatrixEventEvent.Replaced on client updates the affected thread immediately.
    const r2 = firstThread.findEventById('$card_0_r2')!;
    const replacedEdit = msg(
      '$card_0_edit2',
      AGENT,
      {
        'm.new_content': {
          msgtype: 'm.text',
          body: 'replaced',
          'io.mindroom.ai_run': { version: 1, status: 'completed', cost: { usd: '0.75' } },
        },
        'm.relates_to': { rel_type: RelationType.Replace, event_id: '$card_0_r2' },
      },
      1_700_000_020_000
    );
    await act(async () => {
      r2.makeReplaced(replacedEdit);
      client.emit(MatrixEventEvent.Replaced, r2);
    });
    expect(container.querySelector('[data-card="$card_0"] [data-usage-cost]')?.textContent).toBe(
      '$0.85'
    );

    // Live MatrixEventEvent.Decrypted on client updates an encrypted thread reply once decrypted.
    const encReply = new MatrixEvent({
      type: EventType.RoomMessageEncrypted,
      event_id: '$card_1_enc',
      room_id: ROOM_ID,
      sender: AGENT,
      origin_server_ts: 1_700_000_030_000,
      content: {
        algorithm: 'm.megolm.v1.aes-sha2',
        ciphertext: 'cipher',
        'm.relates_to': { rel_type: RelationType.Thread, event_id: '$card_1' },
      },
    });
    const secondThread = room.getThread('$card_1')!;
    await act(async () => {
      secondThread.addEvents([encReply], false);
      await encReply.attemptDecryption({
        decryptEvent: async () => ({
          clearEvent: {
            type: EventType.RoomMessage,
            content: {
              msgtype: 'm.text',
              body: 'decrypted',
              'm.relates_to': { rel_type: RelationType.Thread, event_id: '$card_1' },
              'io.mindroom.ai_run': { version: 1, status: 'completed', cost: { usd: '0.30' } },
            },
          },
        }),
      } as never);
      client.emit(MatrixEventEvent.Decrypted, encReply);
    });
    expect(container.querySelector('[data-card="$card_1"] [data-usage-cost]')?.textContent).toBe(
      '$0.40'
    );

    // When a decrypted event's target thread cannot be resolved yet, subscribed threads still refresh.
    const thirdThread = room.getThread('$card_2')!;
    const r2Card2 = thirdThread.findEventById('$card_2_r1')!;
    r2Card2.event.unsigned = {
      'm.relations': {
        'm.replace': {
          type: EventType.RoomMessage,
          event_id: '$card_2_bundled',
          room_id: ROOM_ID,
          sender: AGENT,
          origin_server_ts: 1_700_000_040_000,
          content: {
            msgtype: 'm.text',
            body: '* updated',
            'm.new_content': {
              msgtype: 'm.text',
              body: 'updated',
              'io.mindroom.ai_run': { version: 1, status: 'completed', cost: { usd: '0.55' } },
            },
            'm.relates_to': { rel_type: RelationType.Replace, event_id: '$card_2_r1' },
          },
        },
      },
    };
    const unresolvedDecrypted = msg('$detached_decrypted', AGENT, { body: 'detached' });
    await act(async () => {
      client.emit(MatrixEventEvent.Decrypted, unresolvedDecrypted);
    });
    expect(container.querySelector('[data-card="$card_2"] [data-usage-cost]')?.textContent).toBe(
      '$0.55'
    );

    // Live ClientEvent.AccountData (m.ignored_user_list) refreshes ignored-user filtering immediately.
    let ignoredSet = new Set<string>([AGENT]);
    vi.spyOn(client, 'isUserIgnored').mockImplementation((u) => ignoredSet.has(u));
    const ignoreEv = new MatrixEvent({
      type: 'm.ignored_user_list',
      content: { ignored_users: { [AGENT]: {} } },
    });
    await act(async () => {
      client.emit(ClientEvent.AccountData, ignoreEv);
    });
    expect(container.querySelector('[data-card="$card_0"] [data-thread-usage-card]')).toBeNull();
    expect(container.querySelector('[data-card="$card_1"] [data-thread-usage-card]')).toBeNull();

    ignoredSet = new Set<string>();
    await act(async () => {
      client.emit(
        ClientEvent.AccountData,
        new MatrixEvent({ type: 'm.ignored_user_list', content: { ignored_users: {} } })
      );
    });
    expect(container.querySelector('[data-card="$card_0"] [data-usage-cost]')?.textContent).toBe(
      '$0.85'
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
    expect(room.listenerCount(RoomEvent.Timeline) - baseRoom.timeline).toBe(0);
    expect(room.listenerCount(RoomEvent.Redaction) - baseRoom.redaction).toBe(0);
    expect(room.listenerCount(RoomEvent.TimelineReset) - baseRoom.reset).toBe(0);
    expect(room.listenerCount(ThreadEvent.New) - baseRoom.threadNew).toBe(0);
    expect(room.listenerCount(ThreadEvent.Update) - baseRoom.update).toBe(0);
    expect(room.listenerCount(ThreadEvent.NewReply) - baseRoom.newReply).toBe(0);
    expect(room.listenerCount(ThreadEvent.Delete) - baseRoom.threadDelete).toBe(0);
    expect(client.listenerCount(MatrixEventEvent.Decrypted) - baseClient.decrypted).toBe(0);
    expect(client.listenerCount(MatrixEventEvent.Replaced) - baseClient.replaced).toBe(0);
    expect(client.listenerCount(ClientEvent.AccountData) - baseClient.accountData).toBe(0);
  });
});
