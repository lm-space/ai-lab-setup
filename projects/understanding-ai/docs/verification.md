# Initial verification — 2026-09-15

- Installed dependencies from the committed lockfile.
- Passed TypeScript type checking, two automated tests and the Vite production frontend build.
- Tests cover skill deduplication/unknown selection and local OpenAI-compatible model discovery/streaming without an API key.
- Browser check on macOS: page renders, settings list providers/models/skills, Ollama model discovery works, and the browser reports no uncaught errors.
- Real local Ollama `qwen2.5:3b`: completed a plain-language answer with the Explain simply skill.
- Real browser tool run: model requested `kb__list`, received the empty local document inventory, completed a second model round and saved 26 trace events with the final answer.
- No cloud API calls were made. Optional external MCP presets, file parsers and embedding-model downloads were not exercised in this verification.

These checks establish the initial local path, not all-model compatibility or hosted production readiness. Runtime chats and browser artifacts are ignored and excluded from publication.
