import type { CSSProperties } from 'react';
import { color, config } from 'folds';

/**
 * CSS custom properties bridged from MindRoom Chat's folds tokens so the card strip and thread
 * details follow light, dark, and custom themes automatically.
 */
export function pluginRootStyle(): CSSProperties {
  return {
    '--tu-fg': color.Surface.OnContainer,
    '--tu-muted': color.SurfaceVariant.OnContainer,
    '--tu-quiet': config.opacity.P400,
    '--tu-surface': color.Surface.Container,
    '--tu-primary': color.Primary.Main,
    '--tu-warning': color.Warning.Main,
    '--tu-critical': color.Critical.Main,
    '--tu-font-sans': config.font.Inter,
  } as CSSProperties;
}
