# AI Lab Setup

Runnable AI projects that make the machinery behind an assistant visible.

**First project: [Understanding AI](projects/understanding-ai/README.md)** — a working agent harness with chat, a live execution graph, inspectable provider requests, tools, MCP connections, skills, local document retrieval, and saved history.

## Quick start

Prerequisites: Node.js 22.14+, pnpm (the project pins its version), and `curl`/`lsof`. Use macOS, Linux, or WSL2. Docker is not required for the first project.

```bash
git clone https://github.com/lm-space/ai-lab-setup.git
cd ai-lab-setup
./setup.sh setup understanding-ai
```

Open http://127.0.0.1:4186. In Settings, choose Ollama and load an installed tool-capable model, or select a cloud provider and enter its API key. Ollama must be installed/running and the chosen model downloaded separately. Its endpoint defaults to `http://127.0.0.1:11434`.

```bash
./setup.sh list
./setup.sh start understanding-ai
./setup.sh status understanding-ai
./setup.sh logs understanding-ai
./setup.sh stop understanding-ai
./setup.sh test understanding-ai
./setup.sh build understanding-ai
```

## Repository

- `projects/understanding-ai/`: independently runnable first project.
- Project roadmaps live alongside each project under `docs/`.
- Future projects may use TypeScript, Python, Go, or Rust, with SQLite by default and Docker Postgres where required. The imported first project currently uses local JSON files and a MiniLM vector index.

This is an educational local development application. Its trace shows this harness's observable behavior, not ChatGPT's private implementation or hidden reasoning. Model output, tool availability, and provider capabilities vary.

See [contribution instructions](CONTRIBUTING.md), [security boundaries](SECURITY.md), and [source provenance](projects/understanding-ai/docs/provenance.md). No open-source license has been selected yet; public visibility alone does not grant a reuse license.
