import { useEffect, useState } from "react";
import type { TraceEvent } from "../shared/types";
export type RequestRun = { startedAt: number; lastActivity: number; endedAt: number | null; error: string; hasOutput: boolean };
export function RequestStatus({ run, events }: { run: RequestRun; events: TraceEvent[] }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (run.endedAt) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [run.startedAt, run.endedAt]);
  const rows = events.filter(e => e.t >= run.startedAt);
  const metrics = rows.filter(e => e.title === "Model request metrics").map(e => e.payload as { durationMs: number; outputTokens: number | null; inputTokens: number | null; firstTextMs: number | null });
  const elapsed = Math.max(0, (run.endedAt || now) - run.startedAt);
  const quiet = !run.endedAt && now - run.lastActivity >= 15000;
  const tokensKnown = metrics.length > 0 && metrics.every(m => m.outputTokens !== null);
  const output = metrics.reduce((sum, m) => sum + (m.outputTokens || 0), 0);
  const modelMs = metrics.reduce((sum, m) => sum + m.durationMs, 0);
  const state = run.error ? "Request failed · response may be incomplete" : run.endedAt ? "Request complete" : quiet ? "No recent activity · still waiting" : run.hasOutput ? "Receiving response / processing" : "Waiting for model or tools";
  return <section className={`requestStatus ${run.error || quiet ? "requestWarning" : ""}`} aria-label="Last request performance">
    <strong role="status">{state}</strong>
    <div className="requestMetrics"><span>Total {(elapsed / 1000).toFixed(1)}s</span><span>Completed model calls {(modelMs / 1000).toFixed(1)}s</span><span>{tokensKnown && modelMs > 0 ? `${(output / (modelMs / 1000)).toFixed(1)} output tokens/s` : `Tokens/s: ${run.endedAt ? "unavailable" : "awaiting provider usage"}`}</span><span>{tokensKnown ? `${output} output tokens` : "Token count unavailable"}</span>{metrics[0]?.firstTextMs != null && <span>First text {(metrics[0].firstTextMs / 1000).toFixed(2)}s</span>}</div>
    {!run.endedAt && <small>{quiet ? "The model may be loading or the provider may be stalled. Each model request times out after 120 seconds. " : ""}Latest stage: {rows.at(-1)?.title || "Opening request"}</small>}
    <small>Rate uses provider-reported output tokens ÷ completed model-call time, including initial wait. Total includes retrieval and tools. Missing counts are never estimated.</small>
  </section>;
}
