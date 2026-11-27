import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', testing: 'src/testing/index.ts', node: 'src/node.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'es2022',
  external: ['@x402/core'],
});
