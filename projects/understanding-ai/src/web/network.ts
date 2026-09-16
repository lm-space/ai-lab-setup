import type { TraceEvent } from "../shared/types";
export function browserFetch(emit: (event: TraceEvent) => void): typeof fetch {
  return async (input, init) => {
    const id = crypto.randomUUID();
    const started = performance.now();
    let seq = 0;
    const target = input instanceof Request ? input.url : String(input);
    const method = init?.method || "GET";
    const log = (phase: TraceEvent["phase"], payload: unknown, status?: number | string) => emit({
      id: crypto.randomUUID(), runId: id, correlationId: id, seq: seq++, round: 0, t: Date.now(),
      kind: "browser_http", title: `${method} ${target} · ${phase}`, lane: "user-app", category: "network", callType: "local", phase, method, target, status,
      durationMs: phase === "start" ? undefined : Math.round(performance.now() - started), payload,
      flow: { nodes: [], edges: [], active: [] },
    });
    const headers = new Headers(init?.headers); headers.set("x-lab-run-id", id);
    log("start", { direction: "Browser → local lab API", method, target, note: "Request bodies are omitted here; inspect server context/tool events for redacted inputs." });
    try {
      const response = await fetch(input, { ...init, headers });
      log("response", { direction: "Local lab API → browser", contentType: response.headers.get("content-type") }, response.status);
      if (!response.body) { log("complete", { bytes: 0 }, response.status); return response; }
      const reader = response.body.getReader(); let bytes = 0;
      return new Response(new ReadableStream({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) { log(response.ok ? "complete" : "error", { bytes }, response.status); controller.close(); }
            else { bytes += next.value.byteLength; controller.enqueue(next.value); }
          } catch (error) { log("error", { error: String(error) }); controller.error(error); }
        },
        async cancel(reason) { await reader.cancel(reason); log("error", { reason: "cancelled" }); },
      }), { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { log("error", { error: String(error) }); throw error; }
  };
}
