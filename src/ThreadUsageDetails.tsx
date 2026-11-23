import { useTranslation } from 'react-i18next';
import { usePluginTranslation, type ThreadDetailProps } from '@mindroom/client-sdk/core';
import { contextSeverity, formatCompactTokens, formatCostUsd, formatExactTokens } from './format';
import { pluginRootStyle } from './theme';
import { PLUGIN_ID, TOKEN_KINDS, useThreadUsage } from './threadUsage';

/** Read-only breakdown rows for Compact hover cards, thread menus, and sidebar hover cards. */
export function ThreadUsageDetails({ room, threadId }: ThreadDetailProps) {
  const summary = useThreadUsage(room, threadId);
  const t = usePluginTranslation(PLUGIN_ID);
  const { i18n } = useTranslation();
  const locale = i18n.language || undefined;
  if (!summary) return null;

  const tokenParts = TOKEN_KINDS.flatMap((kind) => {
    const count = summary.tokenCounts[kind];
    if (!count) return [];
    return [
      t(`details.tokenKind.${kind}`, {
        value: formatCompactTokens(count, locale, { lowerBound: !summary.tokensComplete }),
      }),
    ];
  });

  const ctx = summary.context;
  const pct = ctx ? ctx.percentage : 0;
  const severity = ctx ? contextSeverity(pct) : 'normal';
  const cachePct =
    ctx && ctx.cacheReadTokens !== undefined && ctx.inputTokens > 0
      ? pct * (ctx.cacheReadTokens / ctx.inputTokens)
      : undefined;
  const uncachedPct = cachePct !== undefined ? Math.max(0, pct - cachePct) : pct;
  const contextParts =
    ctx && ctx.cacheReadTokens !== undefined && ctx.cacheReadTokens > 0
      ? [
          t('details.tokenKind.cacheRead', {
            value: formatCompactTokens(ctx.cacheReadTokens, locale),
          }),
          ...(ctx.inputTokens > ctx.cacheReadTokens
            ? [
                t('details.tokenKind.newInput', {
                  value: formatCompactTokens(ctx.inputTokens - ctx.cacheReadTokens, locale),
                }),
              ]
            : []),
        ]
      : [];

  return (
    <div className="mrtu-details" data-thread-usage-details="" style={pluginRootStyle()}>
      {summary.totalCostUsd !== undefined ? (
        <div className="mrtu-detail-block" data-usage-detail="cost">
          <div className="mrtu-detail-row">
            <span className="mrtu-detail-label">{t('details.cost')}</span>
            <span className="mrtu-detail-value">
              {summary.costComplete
                ? formatCostUsd(summary.totalCostUsd, locale)
                : t('details.atLeast', {
                    value: formatCostUsd(summary.totalCostUsd, locale, { lowerBound: true }),
                  })}
            </span>
          </div>
          {summary.subagentsCostUsd > 0 ? (
            <span className="mrtu-detail-sub">
              {t('details.subagents', {
                cost: formatCostUsd(summary.subagentsCostUsd, locale, {
                  lowerBound: !summary.costComplete,
                }),
              })}
            </span>
          ) : null}
        </div>
      ) : null}

      {summary.totalTokens !== undefined ? (
        <div className="mrtu-detail-block" data-usage-detail="tokens">
          <div className="mrtu-detail-row">
            <span className="mrtu-detail-label">{t('details.tokens')}</span>
            <span className="mrtu-detail-value">
              {summary.tokensComplete
                ? formatExactTokens(summary.totalTokens, locale)
                : t('details.atLeast', { value: formatExactTokens(summary.totalTokens, locale) })}
            </span>
          </div>
          {tokenParts.length > 0 ? (
            <span className="mrtu-detail-sub">{tokenParts.join(' · ')}</span>
          ) : null}
        </div>
      ) : null}

      {summary.models.length > 0 ? (
        <div className="mrtu-detail-block" data-usage-detail="models">
          <div className="mrtu-detail-row">
            <span className="mrtu-detail-label">
              {t('details.model', { count: summary.models.length })}
            </span>
            <span className="mrtu-detail-value">{summary.models.join(', ')}</span>
          </div>
        </div>
      ) : null}

      {ctx ? (
        <div className="mrtu-detail-block" data-usage-detail="context">
          <div className="mrtu-detail-row">
            <span className="mrtu-detail-label">{t('details.context')}</span>
            <span className="mrtu-detail-value">
              {t('details.contextSummary', {
                input: formatCompactTokens(ctx.inputTokens, locale),
                window: formatCompactTokens(ctx.windowTokens, locale),
              })}
              {' · '}
              <span className={`mrtu-severity-${severity}`}>
                {t('card.contextPercent', { percent: Math.round(pct) })}
              </span>
            </span>
          </div>
          <div className="mrtu-context-bar" aria-hidden="true">
            {cachePct !== undefined && cachePct > 0 ? (
              <span className="mrtu-bar-cached" style={{ inlineSize: `${cachePct}%` }} />
            ) : null}
            {uncachedPct > 0 ? (
              <span
                className={`mrtu-bar-uncached mrtu-bar-${severity}`}
                style={{ inlineSize: `${uncachedPct}%` }}
              />
            ) : null}
          </div>
          {contextParts.length > 0 ? (
            <span className="mrtu-detail-sub" data-usage-context-breakdown="">
              {contextParts.join(' · ')}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
