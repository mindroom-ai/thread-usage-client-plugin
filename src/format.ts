export type ContextSeverity = 'normal' | 'warning' | 'critical';

const COMPACT_UNITS = [
  { divisor: 1_000, decBelow: 10_000, suffix: 'k' },
  { divisor: 1_000_000, decBelow: 100_000_000, suffix: 'M' },
  { divisor: 1_000_000_000, decBelow: 100_000_000_000, suffix: 'B' },
] as const;

const floorCost = (value: number, fixedDecimals: boolean): number => {
  const [mantissa = '0', expStr = '0'] = value.toExponential().split('e');
  const keep = fixedDecimals ? Number(expStr) + 3 : 2;
  const digits = mantissa.replace('.', '').slice(0, Math.max(1, keep));
  return Number(`${digits[0] ?? '0'}${digits.length > 1 ? `.${digits.slice(1)}` : ''}e${expStr}`);
};

/** Formats USD cost (`$0.00` for 0, 2 decimals from `$0.10` up, 2 sig figs below); floors when `lowerBound`. */
export function formatCostUsd(
  usd: number,
  locale?: string,
  options?: { lowerBound?: boolean }
): string {
  const safe = Number.isFinite(usd) && usd > 0 ? usd : 0;
  const currency = (fmtOpts: Intl.NumberFormatOptions) =>
    new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', ...fmtOpts });
  if (safe === 0) return currency({ minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(0);
  const fixed = options?.lowerBound ? safe >= 0.1 : Number(safe.toPrecision(2)) >= 0.1;
  const value = options?.lowerBound ? floorCost(safe, fixed) : safe;
  if (fixed) return currency({ minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  return currency({ maximumSignificantDigits: 2 }).format(value);
}

/** Compact token count (`850`, `48k`, `420k`, `1.2M`); floors at displayed precision when `lowerBound`. */
export function formatCompactTokens(
  tokens: number,
  locale?: string,
  options?: { lowerBound?: boolean }
): string {
  const safe = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
  const snap = options?.lowerBound ? Math.floor : Math.round;
  const fmt = (value: number, maxDecimals: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: maxDecimals }).format(value);

  if (safe < 1_000) {
    const whole = snap(safe);
    return whole < 1_000 ? fmt(whole, 0) : `${fmt(1, 0)}k`;
  }
  for (let i = 0; i < COMPACT_UNITS.length; i += 1) {
    const unit = COMPACT_UNITS[i];
    if (!unit) continue;
    const next = COMPACT_UNITS[i + 1];
    if (next && safe >= next.divisor) continue;
    if (safe < unit.decBelow) {
      const tenths = snap(safe / (unit.divisor / 10));
      if (tenths < (unit.decBelow / unit.divisor) * 10)
        return `${fmt(tenths / 10, 1)}${unit.suffix}`;
    }
    const whole = snap(safe / unit.divisor);
    if (!next || whole < next.divisor / unit.divisor) return `${fmt(whole, 0)}${unit.suffix}`;
    return `${fmt(1, 0)}${next.suffix}`;
  }
  return fmt(0, 0);
}

/** Localized whole-number token count for detail rows. */
export function formatExactTokens(tokens: number, locale?: string): string {
  const safe = Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) : 0;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(safe);
}

export function clampContextPercentage(percentage: number): number {
  return Number.isFinite(percentage) ? Math.min(100, Math.max(0, percentage)) : 0;
}

export function contextSeverity(percentage: number): ContextSeverity {
  const rounded = Math.round(clampContextPercentage(percentage));
  if (rounded >= 90) return 'critical';
  if (rounded >= 75) return 'warning';
  return 'normal';
}

const GENERIC_MODEL_CONFIGS = new Set(['auto', 'default']);

const titleCaseWords = (value: string): string =>
  value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ');

const formatModelId = (modelId: string): string => {
  const claude = modelId.match(/claude-(?:\d+(?:[-.]\d+)*-)?(opus|sonnet|haiku)(?:-(.*))?/i);
  if (claude?.[1]) {
    const family = titleCaseWords(claude[1]);
    const version = claude[2]?.replace(/-/g, '.').replace(/(?:^|\.)latest$/i, '');
    return version ? `${family} ${version}` : family;
  }
  if (/^gpt-/i.test(modelId)) return modelId.replace(/^gpt/i, 'GPT');
  return titleCaseWords(modelId.replace(/-/g, ' '));
};

/** Compact model badge label matching MindRoom Chat's `getAiRunCompactModelLabel`. */
export function formatModelLabel(model: Record<string, unknown> | undefined): string | undefined {
  if (!model) return undefined;
  const trimmed = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const display = trimmed(model.display_name);
  if (display) return display;
  const config = trimmed(model.config);
  if (config && !GENERIC_MODEL_CONFIGS.has(config.toLowerCase())) return titleCaseWords(config);
  const id = trimmed(model.id);
  if (id) return formatModelId(id);
  const provider = trimmed(model.provider);
  return provider ? titleCaseWords(provider) : undefined;
}
