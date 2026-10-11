import { defineConfig } from 'vite';

// `base: './'` keeps the build relocatable (GitHub Pages project sites live under /<repo>/).
export default defineConfig({
  base: './',
  build: { target: 'es2022', sourcemap: true },
});
