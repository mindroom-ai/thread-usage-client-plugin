import { Fragment, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  usePluginConfig,
  usePluginTranslation,
  type ThreadCardBadgeProps,
} from '@mindroom/client-sdk/core';
import { useScreenSize } from '@mindroom/client-sdk/ui';
import { contextSeverity, formatCompactTokens, formatCostUsd } from './format';
import { pluginRootStyle } from './theme';
import { PLUGIN_ID, readUsageConfig, useThreadUsage } from './threadUsage';

const RING_RADIUS = 5.75;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const PHONE_MAX_SEGMENTS = 2;
const PHONE_PRIORITY: Record<string, number> = { cost: 0, context: 1, tokens: 2, model: 3 };

/** Quiet inline telemetry strip + micro context ring for Compact thread cards (Option B). */
export function ThreadCardUsage({ room, threadId }: ThreadCardBadgeProps) {
  const summary = useThreadUsage(room, threadId);
  const config = readUsageConfig(usePluginConfig(PLUGIN_ID));
  const isPhone = useScreenSize() === 'Mobile';
  const t = usePluginTranslation(PLUGIN_ID);
  const { i18n } = useTranslation();
  const locale = i18n.language || undefined;
  if (!summary) return null;

  const segments: { key: string; node: ReactNode }[] = [];
  if (config.showCost && summary.totalCostUsd !== undefined) {
    const cost = formatCostUsd(summary.totalCostUsd, locale, { lowerBound: !summary.costComplete });
    segments.push({
      key: 'cost',
      node: (
        <span className="mrtu-cost" data-usage-cost="">
          {summary.costComplete ? cost : t('card.lowerBound', { value: cost })}
        </span>
      ),
    });
  }
  if (config.showTokens && summary.totalTokens !== undefined) {
    const tokens = formatCompactTokens(summary.totalTokens, locale, {
      lowerBound: !summary.tokensComplete,
    });
    segments.push({
      key: 'tokens',
      node: (
        <span className="mrtu-tokens" data-usage-tokens="">
          {summary.tokensComplete ? tokens : t('card.lowerBound', { value: tokens })}
        </span>
      ),
    });
  }
  const latestModel = summary.models[0];
  if (config.showModels && latestModel) {
    const extra = summary.models.length - 1;
    segments.push({
      key: 'model',
      node: (
        <span className="mrtu-model-group" data-usage-model="">
          <span className="mrtu-model">{latestModel}</span>
          {extra > 0 ? <span className="mrtu-model-more">{` ${t('card.moreModels', { count: extra })}`}</span> : null}
        </span>
      ),
    });
  }
  if (config.showContext && summary.context !== undefined) {
    const pct = summary.context.percentage;
    const severity = contextSeverity(pct);
    segments.push({
      key: 'context',
      node: (
        <span className={`mrtu-context mrtu-severity-${severity}`} data-usage-context="" data-usage-severity={severity}>
          <svg className="mrtu-ring" viewBox="0 0 16 16" aria-hidden="true">
            <circle className="mrtu-ring-track" cx="8" cy="8" r={RING_RADIUS} strokeWidth="2.2" />
            {pct > 0 ? (
              <circle
                className="mrtu-ring-fill"
                cx="8"
                cy="8"
                r={RING_RADIUS}
                strokeWidth="2.2"
                strokeDasharray={RING_CIRCUMFERENCE}
                strokeDashoffset={RING_CIRCUMFERENCE * (1 - pct / 100)}
                transform="rotate(-90 8 8)"
              />
            ) : null}
          </svg>
          <span>{t('card.contextPercent', { percent: Math.round(pct) })}</span>
        </span>
      ),
    });
  }
  if (segments.length === 0) return null;

  // On phones the metadata row leaves narrow space after avatars, reply count, and the touch menu
  // button, so condense to at most two highest-signal segments (cost + context ring by default);
  // full tokens and models remain one long-press away in threadDetails.
  const shown =
    isPhone && segments.length > PHONE_MAX_SEGMENTS
      ? segments.filter(({ key }) =>
          new Set(
            [...segments]
              .sort((a, b) => (PHONE_PRIORITY[a.key] ?? 9) - (PHONE_PRIORITY[b.key] ?? 9))
              .slice(0, PHONE_MAX_SEGMENTS)
              .map((seg) => seg.key)
          ).has(key)
        )
      : segments;

  return (
    <span className="mrtu-card-strip" data-thread-usage-card="" style={pluginRootStyle()}>
      {shown.map(({ key, node }, index) => (
        <Fragment key={key}>
          {index > 0 ? <span className="mrtu-dot" aria-hidden="true">·</span> : null}
          {node}
        </Fragment>
      ))}
    </span>
  );
}
