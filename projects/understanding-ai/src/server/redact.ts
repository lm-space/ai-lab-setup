const SECRET = /^(.*api[_-]?key|authorization|x-api-key|.*(?:token|secret|password)|bearer|cookie|set-cookie)$/i;

export function redact(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET.test(k)) out[k] = mask(String(v ?? ""));
      else out[k] = redact(v);
    }
    return out;
  }
  return value;
}

function redactString(s: string): string {
  if (/^https?:\/\//.test(s)) {
    try {
      const url = new URL(s); url.username = ""; url.password = "";
      for (const key of url.searchParams.keys()) if (SECRET.test(key) || key === "key") url.searchParams.set(key, "[redacted]");
      return url.toString();
    } catch { /* fall through for non-URL text */ }
  }
  if (s.length > 12 && /^(sk-|or-|ya29|AIza|sk-ant-)/.test(s)) return mask(s);
  return s.replace(/(sk-ant-|sk-|or-)[A-Za-z0-9_\-]{8,}/g, (m) => mask(m));
}

function mask(s: string): string {
  if (s.length <= 8) return "********";
  return s.slice(0, 4) + "..." + s.slice(-4);
}

export function headersForLog(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    out[k] = SECRET.test(k) ? mask(v) : v;
  }
  return out;
}
