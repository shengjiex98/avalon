import { defineConfig } from 'vite';

const buildCommit = process.env.AVALON_BUILD_COMMIT ?? 'dev';
if (buildCommit !== 'dev' && !/^[0-9a-f]{40}$/.test(buildCommit)) {
  throw new Error('AVALON_BUILD_COMMIT must be dev or a 40-character Git commit');
}

export default defineConfig({
  base: './',
  build: {
    emptyOutDir: true,
    manifest: true,
    outDir: 'build/public',
    sourcemap: false,
  },
  define: {
    __AVALON_BUILD_COMMIT__: JSON.stringify(buildCommit),
  },
});
