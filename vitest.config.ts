import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // happy-dom is enough for any DOM-touching code we'd unit-test (panels,
    // hash state, slider wiring). MapLibre itself uses WebGL and can't run
    // here — leave full-map behaviour to Playwright when we add it.
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
  },
});
