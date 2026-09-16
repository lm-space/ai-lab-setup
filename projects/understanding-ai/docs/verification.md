# Initial verification — 2026-09-15

- Installed dependencies from the committed lockfile.
- Passed TypeScript type checking, two automated tests and the Vite production frontend build.
- Tests cover skill deduplication/unknown selection and local OpenAI-compatible model discovery/streaming without an API key.
- Browser check on macOS: page renders, settings list providers/models/skills, Ollama model discovery works, and the browser reports no uncaught errors.
- Real local Ollama `qwen2.5:3b`: completed a plain-language answer with the Explain simply skill.
- Real browser tool run: model requested `kb__list`, received the empty local document inventory, completed a second model round and saved 26 trace events with the final answer.
- No cloud API calls were made. Optional external MCP presets, file parsers and embedding-model downloads were not exercised in this verification.

These checks establish the initial local path, not all-model compatibility or hosted production readiness. Runtime chats and browser artifacts are ignored and excluded from publication.

## Console and settings expansion — 2026-09-15

- Seven automated tests pass, covering HTTP phase correlation, redaction, failure events, live stdio MCP discovery/execution, HTTP MCP instrumentation using a fixture server, provider streaming and legacy User App labels.
- Type checking and frontend build pass.
- Browser exercised the sectioned settings dialog, local model discovery, MCP test/enable controls, real file upload, trace tabs and call-type filtering.
- Real MiniLM import parsed and embedded the synthetic handbook into 384-dimensional vectors and persisted the local index.
- Real Ollama `qwen2.5:3b` used `kb__search` and `lab-demo__add`, answered “Pixel” and “42”, and saved all 50 server trace events with no history mismatch.
- No live cloud provider or third-party MCP service was required. HTTP MCP behavior was checked against a controlled local protocol fixture.
