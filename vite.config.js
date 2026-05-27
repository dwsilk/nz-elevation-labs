import { defineConfig } from 'vite';

export default defineConfig({
  // Set base to './' for GitHub Pages deployment under a repo sub-path.
  // If deploying to a custom domain root, change to '/'.
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
