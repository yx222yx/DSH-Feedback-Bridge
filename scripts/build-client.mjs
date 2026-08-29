import { build } from 'esbuild';

// Build the Client bundle into the DSH ModuleLoader format. The Host half is
// emitted by tsc (tsconfig.host.json); this script is the only generator of
// lib/client.js. The bundle is one classic script registering a single
// factory with the web shell's module loader; the factory receives the
// synchronous require bound to the module table and must require nothing but
// 'react' (the shell-provided platform singleton).

const ID = 'dsh-feedback-bridge';

await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  charset: 'utf8',
  external: ['react'],
  outfile: 'lib/client.js',
  banner: {
    js: `window.__ModuleLoader__.load({
  id: "${ID}",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

`,
  },
  footer: {
    js: `
    return module.exports;
  }
});
`,
  },
  logLevel: 'info',
});
