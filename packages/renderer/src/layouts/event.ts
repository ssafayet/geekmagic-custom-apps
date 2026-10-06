import type { EventFrameLayout, SemanticColor } from '@gca/module-sdk';
import { divider, footer, footerRight } from '../chrome.js';
import { ellipsize, fitFontSize, type FontWeight } from '../fonts.js';
import { CANVAS, CONTENT_WIDTH, SAFE, text, textWidth } from '../svg.js';
import { color, type Theme } from '../theme.js';

const COUNTDOWN_MAX = 40;
const COUNTDOWN_MIN = 24;
const TITLE_SIZE = 19;
const TITLE_LINE_STEP = 23;
const MAX_TITLE_LINES = 2;

/** Fixed vertical rhythm, measured from the top so nothing can collide. */
const ROW = {
  countdownBaseline: 76,
  titleFirst: 106,
  /** The time line sits under the last title line; this is its gap. */
  timeGap: 22,
  divider: 176,
  nextBaseline: 197,
} as const;

const NEXT_LABEL = 'THEN';
const NEXT_GAP = 8;

/**
 * One meeting: when, what, where, and what follows.
 *
 * The countdown gets the largest type because "how long have I got" is the question a
 * glance answers. The title wraps rather than shrinking — meeting names are sentences,
 * and a second line reads better than a smaller first one.
 */
export function renderEvent(layout: EventFrameLayout, theme: Theme, accent: SemanticColor): string {
  const parts: string[] = [];
  const countdownHex = color(theme, layout.countdownTone ?? accent);

  const countdownSize = fitFontSize(layout.countdownText, {
    family: 'display',
    weight: 800,
    fontSize: COUNTDOWN_MAX,
    minFontSize: COUNTDOWN_MIN,
    maxWidth: CONTENT_WIDTH,
  });
  parts.push(
    text({
      x: SAFE.left,
      y: ROW.countdownBaseline,
      text: layout.countdownText,
      size: countdownSize,
      weight: 800,
      fill: countdownHex,
      maxWidth: CONTENT_WIDTH,
    }),
  );

  const titleLines = wrapLines(layout.title, TITLE_SIZE, 700, MAX_TITLE_LINES);
  titleLines.forEach((line, index) => {
    parts.push(
      text({
        x: SAFE.left,
        y: ROW.titleFirst + index * TITLE_LINE_STEP,
        text: line,
        size: TITLE_SIZE,
        weight: 700,
        fill: theme.textPrimary,
        maxWidth: CONTENT_WIDTH,
      }),
    );
  });

  const lastTitleBaseline = ROW.titleFirst + (Math.max(1, titleLines.length) - 1) * TITLE_LINE_STEP;
  const timeLine = layout.detail ? `${layout.timeText} · ${layout.detail}` : layout.timeText;
  parts.push(
    text({
      x: SAFE.left,
      y: lastTitleBaseline + ROW.timeGap,
      text: timeLine,
      size: 13,
      weight: 600,
      fill: theme.textSecondary,
      maxWidth: CONTENT_WIDTH,
    }),
  );

  if (layout.next) {
    const labelWidth = textWidth(NEXT_LABEL, 10, 'display', 600, 0.7);
    const timeX = SAFE.left + labelWidth + NEXT_GAP;
    const timeWidth = textWidth(layout.next.timeText, 12.5, 'display', 700);
    const titleX = timeX + timeWidth + NEXT_GAP;
    parts.push(
      divider(theme, ROW.divider),
      text({
        x: SAFE.left,
        y: ROW.nextBaseline,
        text: NEXT_LABEL,
        size: 10,
        weight: 600,
        fill: theme.textMuted,
        letterSpacing: 0.7,
      }),
      text({
        x: timeX,
        y: ROW.nextBaseline,
        text: layout.next.timeText,
        size: 12.5,
        weight: 700,
        fill: theme.textSecondary,
      }),
      text({
        x: titleX,
        y: ROW.nextBaseline,
        text: layout.next.title,
        size: 12.5,
        weight: 600,
        fill: theme.textSecondary,
        maxWidth: CANVAS - SAFE.right - titleX,
      }),
    );
  }

  parts.push(footer(theme, layout.attribution), footerRight(theme, layout.footer));
  return parts.join('');
}

/**
 * Greedy left-aligned word wrap. Whatever does not fit goes onto the last line, which
 * then ellipsizes, so a long title always ends in `…` rather than silently losing words.
 * A single word wider than the line is broken by the ellipsis like any other overflow.
 */
function wrapLines(value: string, size: number, weight: FontWeight, maxLines: number): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let index = 0;

  while (index < words.length && lines.length < maxLines - 1) {
    let line = words[index]!;
    index += 1;
    while (index < words.length) {
      const candidate = `${line} ${words[index]}`;
      if (!fits(candidate, size, weight)) break;
      line = candidate;
      index += 1;
    }
    lines.push(line);
  }

  if (index < words.length) {
    const rest = words.slice(index).join(' ');
    lines.push(ellipsize(rest, { fontSize: size, weight, maxWidth: CONTENT_WIDTH }));
  }
  return lines;
}

function fits(value: string, size: number, weight: FontWeight): boolean {
  return ellipsize(value, { fontSize: size, weight, maxWidth: CONTENT_WIDTH }) === value;
}
