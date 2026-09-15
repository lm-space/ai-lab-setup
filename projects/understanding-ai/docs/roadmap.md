# Roadmap

## Initial import and expansion

- Complete tracked source import: chat, graph, trace, providers, MCP, knowledge ingestion and history.
- Understanding AI identity and harness overview.
- Ollama compatibility adapter and local model discovery.
- Selectable instruction skills and trace inspection.
- Safe project-owned process lifecycle and credentials omitted from saved preferences.

## Next: explain every boundary

1. Annotate each trace event with a plain-language explanation and elapsed duration.
2. Display discovered tool schemas, connection states and skill instructions in dedicated inspector panels.
3. Add explicit tool permission/approval policies, runtime argument validation and tool timeouts.
4. Add cancellation, token/cost budgets, retry policies and context-window inspection.
5. Replace JSON state with SQLite migrations and durable run records.
6. Add provider/model capability checks and real Ollama/OpenAI/Anthropic conformance runs.
7. Curate and pin verified MCP server packages, with sandbox examples.
8. Export sanitized traces, add deterministic replay scenarios and guided exercises.
9. Add a Docker development path after local lifecycle and security boundaries are tested.

Keep implemented features and proposals separate. Native code examples in Python/Go/Rust can be separate projects later; this project remains TypeScript-first.
