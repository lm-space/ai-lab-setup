import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { TraceMeta } from "../shared/types.ts";
import { redact } from "./redact.ts";

export type TraceSink = (title: string, payload: unknown, meta: TraceMeta) => Promise<void>;
const scope = new AsyncLocalStorage<{ sink: TraceSink; parentId?: string }>();
export function withTrace<T>(sink: TraceSink, fn: () => Promise<T>) { return scope.run({ sink }, fn); }
export async function trace(title: string, payload: unknown, meta: TraceMeta = {}) {
  const context = scope.getStore();
  if (context) await context.sink(title, redact(payload), { parentId: context.parentId, ...meta });
}
export function safeUrl(raw: string) {
  try {
    const url = new URL(raw); url.username = ""; url.password = "";
    for (const key of url.searchParams.keys()) url.searchParams.set(key, "[redacted]");
    return url.toString();
  } catch { return "invalid URL"; }
}

// Instrument actual fetch boundaries. Response timings cover headers; complete covers body consumption.
export function tracedFetch(callType: "ai-provider" | "external"): typeof fetch {
  return async (input, init) => {
    const context = scope.getStore();
    if (!context) return fetch(input, init);
    const correlationId = randomUUID();
    const started = performance.now();
    const target = safeUrl(input instanceof Request ? input.url : String(input));
    const method = init?.method || (input instanceof Request ? input.method : "GET");
    const base: TraceMeta = { category: "network", callType, correlationId, parentId: context.parentId, method, target };
    const emit = (title: string, payload: unknown, meta: TraceMeta) => context.sink(title, redact(payload), { ...base, ...meta });
    let body: unknown = init?.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = { bytes: String(body).length, preview: "Non-JSON body omitted" }; } }
    const headers = Object.fromEntries(new Headers(init?.headers || (input instanceof Request ? input.headers : undefined)));
    await emit(`${method} ${target}`, { request: { method, url: target, headers, body } }, { phase: "start" });
    try {
      const response = await fetch(input, init);
      const responseMeta = { status: response.status, durationMs: Math.round(performance.now() - started) };
      await emit(`HTTP ${response.status} · response headers`, { headers: Object.fromEntries(response.headers), timing: "Time to response headers" }, { ...responseMeta, phase: "response" });
      if (!response.body) {
        await emit("Response complete", { bytes: 0 }, { ...responseMeta, phase: response.ok ? "complete" : "error" });
        return response;
      }
      const reader = response.body.getReader();
      let bytes = 0;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const result = await reader.read();
            if (result.done) {
              await emit("Response body complete", { bytes, timing: "Total request/body duration" }, { status: response.status, phase: response.ok ? "complete" : "error", durationMs: Math.round(performance.now() - started) });
              controller.close();
            } else { bytes += result.value.byteLength; controller.enqueue(result.value); }
          } catch (error) {
            await emit("Response stream failed", { error: String(error), bytes }, { phase: "error", durationMs: Math.round(performance.now() - started) });
            controller.error(error);
          }
        },
        async cancel(reason) {
          await reader.cancel(reason);
          await emit("Response stream cancelled", { bytes }, { phase: "error", status: "cancelled", durationMs: Math.round(performance.now() - started) });
        },
      });
      return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      await emit("Network request failed", { error: String(error) }, { phase: "error", durationMs: Math.round(performance.now() - started) });
      throw error;
    }
  };
}

export async function tracedOperation<T>(title: string, payload: unknown, meta: TraceMeta, fn: () => Promise<T>): Promise<T> {
  const context = scope.getStore();
  const correlationId = randomUUID();
  const started = performance.now();
  await trace(title, payload, { ...meta, correlationId, phase: "start" });
  try {
    const result = context ? await scope.run({ ...context, parentId: correlationId }, fn) : await fn();
    const failed = !!(result && typeof result === "object" && ((result as any).isError || (result as any).error));
    await trace(`${title} · ${failed ? "failed" : "complete"}`, { result }, { ...meta, correlationId, phase: failed ? "error" : "complete", durationMs: Math.round(performance.now() - started) });
    return result;
  } catch (error) {
    await trace(`${title} · failed`, { error: String(error) }, { ...meta, correlationId, phase: "error", durationMs: Math.round(performance.now() - started) });
    throw error;
  }
}
