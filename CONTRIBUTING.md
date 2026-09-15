# Contributing

Keep each project independently runnable with its own README, setup.sh, manifest/lockfile, tests and example configuration. Use current dates for new work; document historical reconstructions explicitly.

For Understanding AI:

```bash
cd projects/understanding-ai
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Use synthetic documents and mocked providers in automated tests. Real cloud tests must be explicit and must report the model/provider/date. Never commit runtime data, keys, uploaded files, or model downloads. Preserve attribution when importing code. Document provider-specific limitations and verify the UI after changes.
