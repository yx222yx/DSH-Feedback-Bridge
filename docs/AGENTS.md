# DeepSeek Harness integration

Read this file when changing how the plugin loads into DSH, uses Host or Client services, registers Web UI, or builds its release bundle.

## Integration rules

- Use documented DSH and Cordis extension points. Keep changes inside this plugin repository.
- Keep Host and Client code separate. Browser code must not import Node-only modules or receive GitHub credentials.
- Register lifecycle resources through DSH/Cordis effects and return their disposers.
- Use official exported DSH and Cordis types when available. Document any narrow local compatibility type.
- Route Client UI text through the typed Chinese and English dictionaries.
- Treat missing required configuration as a visible startup or request error.
- Keep model-visible inputs reconstructable from the recorded feedback session.

## Source and release bundle

- Change production code in `src/` TypeScript or TSX.
- Generate `lib/` through the build scripts; do not edit or commit generated files by hand.
- Keep the DSH compatibility range in `package.json` explicit and fail clearly outside it.
- For packaging changes, inspect the packed file list and install the resulting package into a clean DSH Web profile.

## Verification

Run the narrowest relevant tests, plus `pnpm typecheck` and `pnpm build` for production-code changes. Release changes also require the packed-package checks. Tests must use fake GitHub and model services unless a human explicitly authorizes a real external operation.
