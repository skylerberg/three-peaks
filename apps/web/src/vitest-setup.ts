import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
// Side-effecting: it stubs fetch, Request, WebSocket and the storage objects,
// and has to be evaluated before any module that captures one of them at import
// time -- openapi-fetch reads globalThis.fetch as api/client.ts is evaluated.
// `./api/` sorts ahead of every other local import here, which is what keeps
// that true under a formatter that orders them.
import { FakeWebSocket } from './api/testUtils.ts';
import { realtime } from './lib/realtime.svelte.ts';

// jsdom implements no part of the Web Animations API, and Svelte's `animate:flip`
// asks an element what it is already animating before it starts. Absent, the
// first row a keyed list reorders throws where nothing catches it -- an unhandled
// error beside a green suite.
Element.prototype.getAnimations ??= () => [];

afterEach(() => {
  // The store outlives the test that started it: a socket left open reconnects
  // on a timer, and the next test then reads a socket it did not open.
  realtime.stop();
  FakeWebSocket.reset();
});
