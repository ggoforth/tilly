// Bundles each extension entrypoint to dist/ and copies static assets.
// Content scripts and the MAIN-world probe must be classic (IIFE) scripts,
// not ES modules, so they run in their injected contexts without import wiring.
import * as esbuild from 'esbuild';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const outdir = 'dist';

const entrypoints = {
  worker: 'src/worker/worker.ts',
  content: 'src/content/content.ts',
  probe: 'src/probe/probe.ts',
  options: 'src/options/options.ts',
};

const common = {
  bundle: true,
  format: 'iife',
  target: 'chrome111', // chrome.scripting world:'MAIN' requires Chrome 111+
  platform: 'browser',
  legalComments: 'none',
  logLevel: 'info',
};

// Writes dist/manifest.json. Two modes:
//
// 1. **Dev builds** (no RELEASE_VERSION env var): auto-increments a 4th
//    version segment from .build so every build is visibly distinct (in
//    arc://extensions and the sidebar) — you can confirm at a glance that
//    a reload picked up new code.
//
// 2. **Release builds** (RELEASE_VERSION set, e.g. by the GitHub Actions
//    release workflow): uses the env value verbatim as the manifest
//    version, stripping any leading "v". So a "v0.2.0" git tag produces
//    a clean "0.2.0" manifest, instead of a CI-fresh "0.2.0.1" that
//    would happen with the auto-counter.
async function buildManifest() {
  const base = JSON.parse(await readFile('manifest.json', 'utf8'));

  let version;
  const releaseVer = process.env.RELEASE_VERSION;
  if (releaseVer) {
    version = releaseVer.replace(/^v/, '');
  } else {
    let n = 0;
    try {
      n = parseInt(await readFile('.build', 'utf8'), 10) || 0;
    } catch {
      /* first build */
    }
    n += 1;
    await writeFile('.build', String(n));
    version = `${base.version}.${n}`;
  }

  await writeFile(`${outdir}/manifest.json`, JSON.stringify({ ...base, version }, null, 2));
  await writeFile(
    `${outdir}/options.html`,
    await readFile('src/options/options.html', 'utf8'),
  );
  console.log(`[build] version ${version}${releaseVer ? ' (release)' : ''}`);
}

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const contexts = await Promise.all(
  Object.entries(entrypoints).map(([name, entry]) =>
    esbuild.context({
      ...common,
      entryPoints: { [name]: entry },
      outdir,
      sourcemap: watch ? 'inline' : false,
      minify: !watch,
    }),
  ),
);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
  await buildManifest();
  console.log('[build] watching for changes…');
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
  await buildManifest();
  console.log('[build] done → dist/');
}
