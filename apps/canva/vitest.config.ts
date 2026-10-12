import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { guardMutation } from '../../scripts/guard-mutation.mjs';

export default defineConfig({
  plugins: [guardMutation()],
  cacheDir: process.env.GUARD_CACHE_DIR,
  // The one path alias the app's own imports are written against, which the
  // Canva toolchain reads out of tsconfig and vitest does not.
  resolve: { alias: { src: fileURLToPath(new URL('./src', import.meta.url)) } },
  // Node, not jsdom: what is worth testing here is the design reading, the
  // export guard and the board plan, none of which touches the DOM. The screens
  // are exercised by opening the app, which is the only place Canva's own APIs
  // exist at all.
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
