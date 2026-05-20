// Bundles test/**/*.test.ts with esbuild (reusing our only toolchain — no new
// deps, no Node ESM extension friction), then runs them via Node's built-in
// test runner. Fixtures are read from test/fixtures via process.cwd().
import * as esbuild from 'esbuild';
import { readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const outdir = '.test-dist';
rmSync(outdir, { recursive: true, force: true });

const testFiles = readdirSync('test')
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => `test/${f}`);

if (testFiles.length === 0) {
  console.error('no test files found in test/');
  process.exit(1);
}

await esbuild.build({
  entryPoints: testFiles,
  outdir,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: 'inline',
  logLevel: 'warning',
});

const built = testFiles.map(
  (f) => `${outdir}/${f.split('/').pop().replace(/\.ts$/, '.js')}`,
);
const res = spawnSync('node', ['--test', ...built], { stdio: 'inherit' });
process.exit(res.status ?? 1);
