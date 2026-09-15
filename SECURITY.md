# Security and local-use boundaries

Understanding AI is a single-user local development lab, not a hardened hosted multi-user service. Keep the UI/API on loopback; do not expose them through a public tunnel or bind them to an external interface without adding authentication, request validation, quotas and isolation.

MCP servers execute tools with the permissions of your local process or remote connection. Enabling a stdio preset can download and execute third-party code through npx. Presets are inherited experimental integrations, disabled by default; their package/version availability is not certified by this release. Inspect and pin the server you choose. Custom HTTP connections may access the network. Skill instructions are not a security boundary or authorization policy.

API keys are held in browser memory for the current page session, passed through the local backend, and sent to the selected provider. Stored preferences omit keys. Known credential fields are redacted in traces; arbitrary tool text can still contain sensitive information. Uploaded documents, retrieved chunks, and tool results can enter model requests. Use synthetic data when sharing screenshots or traces.

Chats and uploaded documents are stored under the ignored project data directory. Do not commit them. Stop preserves data. Report vulnerabilities privately to the lm-space organization maintainers; do not put credentials or personal data in public issues.
