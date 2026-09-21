/**
 * Renders every visual-regression fixture to `test-artifacts/frames/` for eyeballing.
 *   pnpm exec tsx --conditions=development tools/scripts/render-fixtures.mts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { finalizeFrame, FrameRenderer } from '@gca/renderer';
import { FRAME_FIXTURES } from '../../packages/renderer/test/fixtures/frames.js';

const outDir = process.argv[2] ?? 'test-artifacts/frames';
mkdirSync(outDir, { recursive: true });

const renderer = new FrameRenderer();
const now = new Date('2026-09-21T12:00:00Z');

for (const fixture of FRAME_FIXTURES) {
  const frame = finalizeFrame(fixture.draft, { now });
  const encoded = await renderer.render(frame);
  writeFileSync(`${outDir}/${fixture.name}.jpg`, encoded.bytes);
  console.log(
    `${fixture.name.padEnd(32)} ${String(encoded.bytes.length).padStart(6)} B  ${encoded.sha256.slice(0, 12)}`,
  );
}
console.log(`\n${FRAME_FIXTURES.length} frames -> ${outDir}`);
