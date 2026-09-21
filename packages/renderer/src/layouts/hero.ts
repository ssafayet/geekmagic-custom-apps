import type { HeroFrameLayout, SemanticColor } from '@gca/module-sdk';
import { BAND, divider, footer } from '../chrome.js';
import { CANVAS, CONTENT_WIDTH, SAFE, text, textWidth } from '../svg.js';
import { fitFontSize } from '../fonts.js';
import { color, type Theme } from '../theme.js';

const HERO_MAX = 64;
const HERO_MIN = 34;

export function renderHero(layout: HeroFrameLayout, theme: Theme, accent: SemanticColor): string {
  const parts: string[] = [];
  const toneHex = color(theme, layout.tone ?? accent);

  const unitWidth = layout.unit ? textWidth(layout.unit, 20, 'display', 600) + 6 : 0;
  const valueSize = fitFontSize(layout.value, {
    family: 'display',
    weight: 800,
    fontSize: HERO_MAX,
    minFontSize: HERO_MIN,
    maxWidth: CONTENT_WIDTH - unitWidth,
  });

  // Anchor the hero optically rather than geometrically: supporting rows below need room.
  const heroBaseline = layout.supporting?.length ? BAND.contentTop + valueSize * 0.86 : 112;

  parts.push(
    text({
      x: SAFE.left,
      y: heroBaseline,
      text: layout.value,
      size: valueSize,
      weight: 800,
      fill: toneHex,
      maxWidth: CONTENT_WIDTH - unitWidth,
    }),
  );

  if (layout.unit) {
    const valueWidth = textWidth(layout.value, valueSize, 'display', 800);
    parts.push(
      text({
        x: SAFE.left + valueWidth + 6,
        y: heroBaseline,
        text: layout.unit,
        size: 20,
        weight: 600,
        fill: theme.textSecondary,
      }),
    );
  }

  let cursorY = heroBaseline + 20;
  if (layout.caption) {
    parts.push(
      text({
        x: SAFE.left,
        y: cursorY,
        text: layout.caption,
        size: 15,
        weight: 600,
        fill: theme.textSecondary,
        maxWidth: CONTENT_WIDTH,
      }),
    );
    cursorY += 20;
  }

  const supporting = layout.supporting ?? [];
  if (supporting.length > 0) {
    cursorY = Math.max(cursorY + 6, 150);
    parts.push(divider(theme, cursorY - 14));
    for (const item of supporting.slice(0, 3)) {
      if (cursorY > BAND.contentBottom) break;
      parts.push(
        text({
          x: SAFE.left,
          y: cursorY,
          text: item.label.toUpperCase(),
          size: 11,
          weight: 600,
          fill: theme.textMuted,
          letterSpacing: 0.6,
          maxWidth: CONTENT_WIDTH * 0.5,
        }),
        text({
          x: CANVAS - SAFE.right,
          y: cursorY,
          text: item.value,
          size: 15,
          weight: 700,
          fill: item.tone ? color(theme, item.tone) : theme.textPrimary,
          anchor: 'end',
          maxWidth: CONTENT_WIDTH * 0.5,
        }),
      );
      cursorY += 21;
    }
  }

  parts.push(footer(theme, layout.footer));
  return parts.join('');
}
