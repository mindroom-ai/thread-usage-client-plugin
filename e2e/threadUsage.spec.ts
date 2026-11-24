import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { chooseFromAccountMenu, loginWithPassword } from '@mindroom/e2e/auth';
import { createRoom } from '@mindroom/e2e/createRoom';
import {
  DISPOSABLE_HOMESERVER as HOMESERVER,
  disposableHomeserverIsUp,
  registerDisposableUser,
  type DisposableUser,
} from '@mindroom/e2e/disposableAccounts';
import { joinRoom, registerAgentAccount, sendRoomMessage } from '@mindroom/e2e/matrix';
import { setRoomCompact } from '@mindroom/e2e/roomViewSwitch';

// End-to-end verification of `thread-usage-client-plugin` (Option B: quiet inline telemetry strip
// + micro context ring on Compact thread cards, plus read-only `threadDetails` hover breakdown).
// Set MRTU_SHOTS=<directory> to capture desktop/phone and light/dark screenshots.

const RUN = Date.now().toString(36);
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const PHONE_CONTEXT = {
  viewport: PHONE,
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
  serviceWorkers: 'block',
} as const;

test.use({ viewport: DESKTOP, deviceScaleFactor: 2, serviceWorkers: 'block' });
test.describe.configure({ mode: 'serial' });

type Seed = {
  person: DisposableUser;
  roomId: string;
  devRoot: string;
  warningRoot: string;
  plainRoot: string;
};

let seeded: Seed | undefined;

const threadReply = (rootId: string, body: string, extra: Record<string, unknown> = {}) => ({
  msgtype: 'm.text',
  body,
  'm.relates_to': {
    rel_type: 'm.thread',
    event_id: rootId,
    is_falling_back: true,
    'm.in_reply_to': { event_id: rootId },
  },
  ...extra,
});

const shot = async (page: Page, name: string, target?: Locator) => {
  const dir = process.env.MRTU_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.png`);
  if (target) await target.screenshot({ path, animations: 'disabled' });
  else await page.screenshot({ path, animations: 'disabled' });
};

const card = (page: Page, rootId: string) =>
  page.locator(`[data-compact-room-view] button[data-thread-root-id="${rootId}"]`);

const usageStrip = (page: Page, rootId: string) =>
  card(page, rootId).locator('[data-compact-card-metadata] [data-thread-usage-card]');

const expectStripInsideMetadata = async (page: Page, rootId: string) => {
  const meta = card(page, rootId).locator('[data-compact-card-metadata]');
  const strip = usageStrip(page, rootId);
  const lastChild = strip.locator(':scope > :last-child');
  await expect(strip).toBeVisible({ timeout: 30_000 });
  const [metaBox, stripBox, lastChildBox] = await Promise.all([
    meta.boundingBox(),
    strip.boundingBox(),
    lastChild.boundingBox(),
  ]);
  expect(metaBox).not.toBeNull();
  expect(stripBox).not.toBeNull();
  expect(lastChildBox).not.toBeNull();
  for (const box of [stripBox!, lastChildBox!]) {
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    expect(box.x).toBeGreaterThanOrEqual(metaBox!.x - 1);
    expect(box.y).toBeGreaterThanOrEqual(metaBox!.y - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(metaBox!.x + metaBox!.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(metaBox!.y + metaBox!.height + 1);
  }
};

const openCompactRoom = async (page: Page, data: Seed) => {
  await loginWithPassword(page, { homeserver: HOMESERVER, ...data.person });
  await page.goto(`/home/${encodeURIComponent(data.roomId)}/`);
  await setRoomCompact(page, true);
  await expect(card(page, data.devRoot)).toBeVisible({ timeout: 60_000 });
};

const enableThreadUsagePlugin = async (page: Page) => {
  await chooseFromAccountMenu(page, 'Settings');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Plugins', exact: true })
    .click();
  const toggle = dialog.getByRole('switch', { name: 'Thread Usage', exact: true });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
};

test.beforeAll(async () => {
  if (!(await disposableHomeserverIsUp())) return;
  const person = await registerDisposableUser(`usage_user_${RUN}`, 'thread-usage-e2e-pass');
  const peer = await registerDisposableUser(`usage_peer_${RUN}`, 'thread-usage-e2e-pass');
  const agent = await registerAgentAccount(HOMESERVER, `usage_dev_${RUN}`);

  const roomId = await createRoom(HOMESERVER, person.accessToken, {
    name: 'Platform Engineering',
    invite: [peer.userId, agent.userId],
  });
  await joinRoom(HOMESERVER, peer.accessToken, roomId);
  await joinRoom(HOMESERVER, agent.accessToken, roomId);

  // 1. Plain human-only thread: no usage strip and no usage details.
  const plainRoot = await sendRoomMessage(HOMESERVER, person.accessToken, roomId, {
    msgtype: 'm.text',
    body: 'Thursday release schedule',
  });
  await sendRoomMessage(
    HOMESERVER,
    peer.accessToken,
    roomId,
    threadReply(plainRoot, 'Let us cut the release tag right after lunch.')
  );

  // 2. High-context warning thread (88% context fill).
  const warningRoot = await sendRoomMessage(HOMESERVER, person.accessToken, roomId, {
    msgtype: 'm.text',
    body: 'Audit TLS certificate renewal pipeline',
  });
  await sendRoomMessage(
    HOMESERVER,
    agent.accessToken,
    roomId,
    threadReply(warningRoot, 'Checked all staging and production ACME hooks; rotation passes.', {
      'io.mindroom.ai_run': {
        version: 1,
        status: 'completed',
        model: { id: 'anthropic/claude-sonnet-5.5', display_name: 'Sonnet 5.5' },
        cost: { usd: '0.38' },
        usage: {
          cache_read_tokens: 140_000,
          uncached_input_tokens: 36_000,
          output_tokens: 14_000,
        },
        context: {
          input_tokens: 176_000,
          window_tokens: 200_000,
          cache_read_input_tokens: 140_000,
          uncached_input_tokens: 36_000,
        },
      },
    })
  );

  // 3. Unread dev thread with multiple models, subagents cost, 420k tokens, and 64% context.
  const devRoot = await sendRoomMessage(HOMESERVER, person.accessToken, roomId, {
    msgtype: 'm.text',
    body: 'Migrate webhook retries to exponential backoff',
  });
  await sendRoomMessage(
    HOMESERVER,
    agent.accessToken,
    roomId,
    threadReply(devRoot, 'Mapped all webhook consumers and drafted the backoff schedule.', {
      'io.mindroom.ai_run': {
        version: 1,
        status: 'completed',
        model: { id: 'anthropic/claude-sonnet-5.5', display_name: 'Sonnet 5.5' },
        cost: { usd: '0.42', subagents_usd: '0.18' },
        usage: {
          cache_read_tokens: 160_000,
          uncached_input_tokens: 30_000,
          cache_write_tokens: 20_000,
          output_tokens: 10_000,
        },
        context: { input_tokens: 72_000, window_tokens: 200_000 },
      },
    })
  );
  // Seed the second reply using MindRoom's real streaming pattern: placeholder message without
  // io.mindroom.ai_run followed by a final m.replace edit carrying io.mindroom.ai_run.
  const streamedReplyId = await sendRoomMessage(
    HOMESERVER,
    agent.accessToken,
    roomId,
    threadReply(devRoot, 'Thinking...', { 'io.mindroom.stream_status': 'pending' })
  );
  await sendRoomMessage(HOMESERVER, agent.accessToken, roomId, {
    msgtype: 'm.text',
    body: '* Implemented jittered retries with dead-letter tests passing.',
    'io.mindroom.stream_status': 'completed',
    'm.new_content': {
      msgtype: 'm.text',
      body: 'Implemented jittered retries with dead-letter tests passing.',
      'io.mindroom.stream_status': 'completed',
      'io.mindroom.ai_run': {
        version: 1,
        status: 'completed',
        model: { id: 'anthropic/claude-opus-5.5', display_name: 'Opus 5.5' },
        cost: { usd: '0.66', subagents_usd: '0.16' },
        usage: {
          cache_read_tokens: 120_000,
          uncached_input_tokens: 60_000,
          cache_write_tokens: 20_000,
          output_tokens: 40_000,
        },
        context: {
          input_tokens: 128_000,
          window_tokens: 200_000,
          cache_read_input_tokens: 96_000,
          uncached_input_tokens: 32_000,
        },
      },
    },
    'm.relates_to': { rel_type: 'm.replace', event_id: streamedReplyId },
  });

  seeded = { person, roomId, devRoot, warningRoot, plainRoot };
});

test.beforeEach(async () => {
  test.skip(!(await disposableHomeserverIsUp()), `No homeserver at ${HOMESERVER}`);
});

test('shows quiet inline usage strips, warning context ring, and hover details in light and dark themes', async ({
  page,
}) => {
  const data = seeded!;
  await openCompactRoom(page, data);
  await expect(card(page, data.warningRoot)).toBeVisible({ timeout: 30_000 });

  // Off by default (defaultEnabled: false): no usage strips until enabled in Settings -> Plugins.
  await expect(usageStrip(page, data.devRoot)).toHaveCount(0);
  await expect(usageStrip(page, data.warningRoot)).toHaveCount(0);

  await enableThreadUsagePlugin(page);

  const devStrip = usageStrip(page, data.devRoot);
  await expect(devStrip).toBeVisible({ timeout: 30_000 });
  await expect(devStrip.locator('[data-usage-cost]')).toHaveText(/^(?:≥ )?\$1\.42$/);
  await expect(devStrip.locator('[data-usage-tokens]')).toHaveText(/^(?:≥ )?420k$/);
  await expect(devStrip.locator('[data-usage-model]')).toHaveText('Opus 5.5 +1');
  await expect(devStrip.locator('[data-usage-context]')).toHaveText('64%');
  await expect(devStrip.locator('[data-usage-context]')).toHaveAttribute(
    'data-usage-severity',
    'normal'
  );

  const warnStrip = usageStrip(page, data.warningRoot);
  await expect(warnStrip.locator('[data-usage-cost]')).toHaveText(/^(?:≥ )?\$0\.38$/);
  await expect(warnStrip.locator('[data-usage-tokens]')).toHaveText(/^(?:≥ )?190k$/);
  await expect(warnStrip.locator('[data-usage-model]')).toHaveText('Sonnet 5.5');
  await expect(warnStrip.locator('[data-usage-context]')).toHaveText('88%');
  await expect(warnStrip.locator('[data-usage-context]')).toHaveAttribute(
    'data-usage-severity',
    'warning'
  );

  // Plain human-only thread shows no usage strip.
  await expect(card(page, data.plainRoot).locator('[data-thread-usage-card]')).toHaveCount(0);

  const cardList = page.locator('[data-compact-room-view]');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme-kind', 'light');
  await shot(page, 'desktop-light', cardList);

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme-kind', 'dark');
  await shot(page, 'desktop-dark', cardList);

  // Resting the pointer on the dev card opens the thread details hover card with full breakdown.
  const hoverDetails = page.locator('[data-thread-card-details] [data-thread-usage-details]');
  await card(page, data.devRoot).hover();
  await expect(hoverDetails).toBeVisible({ timeout: 10_000 });
  await expect(hoverDetails).toContainText('$1.42');
  await expect(hoverDetails).toContainText('+$0.34 subagents');
  await expect(hoverDetails).toContainText('Opus 5.5, Sonnet 5.5');
  await expect(hoverDetails).toContainText('128k / 200k · 64%');
  await expect(hoverDetails.locator('[data-usage-context-breakdown]')).toHaveText(
    '96k cached · 32k new'
  );
  await shot(page, 'hover-dark');

  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme-kind', 'light');
  await card(page, data.devRoot).hover();
  await expect(hoverDetails).toBeVisible({ timeout: 10_000 });
  await shot(page, 'hover-light');

  // Clicking the non-interactive telemetry strip opens the thread directly and loads full history.
  await devStrip.click();
  await expect(page).toHaveURL(new RegExp(`threadId=${encodeURIComponent(data.devRoot)}`));
  await expect(
    page.getByText('Mapped all webhook consumers and drafted the backoff schedule.')
  ).toBeVisible({ timeout: 30_000 });

  // Returning to Compact view keeps the loaded history, so cost and tokens render exact (no ≥).
  await page.goBack();
  await expect(devStrip).toBeVisible({ timeout: 30_000 });
  await expect(devStrip.locator('[data-usage-cost]')).toHaveText('$1.42');
  await expect(devStrip.locator('[data-usage-tokens]')).toHaveText('420k');
  await expect(devStrip.locator('[data-usage-model]')).toHaveText('Opus 5.5 +1');
  await expect(devStrip.locator('[data-usage-context]')).toHaveText('64%');

  await page.mouse.move(0, 0);
  await card(page, data.devRoot).hover();
  await expect(hoverDetails).toBeVisible({ timeout: 10_000 });
  await expect(hoverDetails.locator('[data-usage-detail="cost"] .mrtu-detail-value')).toHaveText(
    '$1.42'
  );
  await expect(hoverDetails.locator('[data-usage-detail="tokens"] .mrtu-detail-value')).toHaveText(
    '420,000'
  );
  await expect(hoverDetails.locator('[data-usage-context-breakdown]')).toHaveText(
    '96k cached · 32k new'
  );
});

test('keeps telemetry legible on a phone viewport in dark and light modes', async ({
  browser,
  baseURL,
}) => {
  const data = seeded!;
  const context = await browser.newContext({ baseURL, ...PHONE_CONTEXT });
  const page = await context.newPage();
  try {
    await openCompactRoom(page, data);
    await expectStripInsideMetadata(page, data.devRoot);
    await expectStripInsideMetadata(page, data.warningRoot);
    await expect(card(page, data.plainRoot).locator('[data-thread-usage-card]')).toHaveCount(0);

    const cardList = page.locator('[data-compact-room-view]');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme-kind', 'dark');
    await shot(page, 'phone-dark', cardList);

    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme-kind', 'light');
    await shot(page, 'phone-light', cardList);
  } finally {
    await context.close();
  }
});
