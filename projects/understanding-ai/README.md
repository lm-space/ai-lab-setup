# Understanding AI

Part of [AI Lab Setup](../../README.md). Ask a question and inspect the real steps this agent harness performs around its model.

## What you can see

- **Harness overview:** instructions, selected skills, context, model, tool connections, agent loop and storage.
- **Chat and live graph:** the user's request, model calls, tool requests/results and final response.
- **Trace payloads:** inspect system/context packing, discovered tool schemas, model usage when reported and loop termination. Selecting an earlier step restores its graph snapshot.
- **Skills:** Explain simply, Evidence first and Compare options add actual instructions to the model request; their resolution is traced.
- **Connections:** Ollama, OpenAI, Anthropic, plus imported OpenRouter and Google adapters. Optional MCP stdio/HTTP connections are discovered at runtime.
- **Knowledge:** upload Markdown, text, PDF, Word, CSV, Excel and JSON files; inspect extraction, chunking, MiniLM embeddings, local retrieval and table tools.
- **History:** reopen locally saved conversations and their trace events.

The graph describes this application. It does not reveal ChatGPT's proprietary internals. Any reasoning block shown is only material explicitly returned by a provider; it is not a complete explanation of the model's internal computation.

## Start

```bash
./setup.sh setup
```

Requires Node 22.14+, pnpm, curl and lsof. Default UI: http://127.0.0.1:4186; API health: http://127.0.0.1:4188/api/health. Configuration is copied from `.env.example` on setup. Change PORT/API_PORT in `.env` if occupied. Setup installs locked dependencies; start resumes existing dependencies; stop preserves local data.

### Ollama

Install/run Ollama separately and download a model that supports tools on your hardware. Open Settings → Ollama → Load models from provider → choose a model → Done. The list comes from the configured local server; there is no hard-coded model download. Set `OLLAMA_BASE_URL` in `.env` for a different local inference endpoint. No API key is required. Model/tool compatibility and hardware limits still apply.

### Cloud providers

Choose the provider, enter its key for this page session, and load/select a model. Requests may incur provider charges. Imported suggested model IDs are examples, not a guarantee of current availability. API keys are not persisted; switching providers clears the current key.

### MCP and skills

Skills are instruction packages; tools execute operations. Select skills in Settings, then inspect `skills_resolved` and `system_prompt` events on the next request. MCP presets are optional, disabled by default, and connect on each run. Only enable servers you trust. Local knowledge tools are available without an MCP connection.

## Walkthrough

1. Select a provider/model and enable Explain simply.
2. Ask “Explain how a tool-using assistant differs from a language model.” Inspect skill selection and the packed prompt.
3. Upload a small synthetic document, then ask a question about it. Watch ingestion and tool requests; actual tool selection depends on the model.
4. Expand a tool result in the trace. Click an earlier step to view its graph.
5. Reopen the chat from History. Compare runs with different skills or providers.

## Verify

```bash
./setup.sh test
./setup.sh build
```

Tests use a local fake HTTP provider to verify adapter behavior without paid requests. They do not establish live cloud or real-model compatibility. See [architecture](docs/architecture.md), [roadmap](docs/roadmap.md), [provenance](docs/provenance.md), and [security](../../SECURITY.md).

## Current limits

Local JSON storage and a file-based vector index are preserved from the source. SQLite migration, durable resumable runs, explicit tool approvals, comprehensive schema validation, budgets/cancellation, curated version-pinned MCP packages and broader live provider conformance are follow-up work. The browser UI and API run together in development mode; `build` validates/builds the UI but is not a hosted deployment package. Native desktop control, autonomous multi-agent scheduling and an installable skill marketplace are not implemented.
