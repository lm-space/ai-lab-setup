import { useEffect, useMemo, useRef, useState } from "react";
import type { FlowSnap } from "../shared/types";

const KIND_COLOR: Record<string, string> = {
  compute: "#9ccb8a",
  model: "#b9a1e8",
  data: "#4fd8eb",
  store: "#e3a23c",
  actor: "#7fb2e8",
  external: "#8c99ab",
};

type Pos = { x: number; y: number; w: number; h: number };

export function Flow({ snap }: { snap: FlowSnap | null }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 280 });

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(() => {
    const nodes = (snap?.nodes || []).map((node) => node.id === "user" ? { ...node, label: "User App" } : node);
    const maxCol = Math.max(0, ...nodes.map((n) => n.col));
    const maxRow = Math.max(0, ...nodes.map((n) => n.row));
    const padX = 24;
    const padY = 28;
    const nw = 128;
    const nh = 52;
    const usableW = Math.max(size.w - padX * 2, 400);
    const usableH = Math.max(size.h - padY * 2, 160);
    const gapX = maxCol === 0 ? 0 : (usableW - nw) / maxCol;
    const gapY = maxRow === 0 ? 0 : (usableH - nh) / maxRow;
    const pos = new Map<string, Pos>();
    const nextRow = new Map<number, number>();
    for (const n of nodes) {
      const row = Math.max(n.row, nextRow.get(n.col) || 0);
      nextRow.set(n.col, row + 1);
      pos.set(n.id, {
        x: padX + n.col * gapX,
        y: padY + row * Math.max(gapY, 64),
        w: nw,
        h: nh,
      });
    }
    const height = Math.max(size.h, ...[...pos.values()].map((p) => p.y + p.h + padY));
    return { pos, nw, nh, height };
  }, [snap, size]);

  if (!snap || snap.nodes.length === 0) {
    return (
      <div className="flowWrap" ref={wrap}>
        <div className="empty">The flow appears as you upload a file or send a question.</div>
      </div>
    );
  }

  return (
    <div className="flowWrap" ref={wrap}>
      <svg className="flowSvg" style={{ height: layout.height, position: "relative", display: "block" }} viewBox={`0 0 ${size.w} ${layout.height}`}>
        {snap.edges.map((e, i) => {
          const a = layout.pos.get(e.from);
          const b = layout.pos.get(e.to);
          if (!a || !b) return null;
          const x1 = a.x + a.w;
          const y1 = a.y + a.h / 2;
          const x2 = b.x;
          const y2 = b.y + b.h / 2;
          const mx = (x1 + x2) / 2;
          const d = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
          const anim = e.animated !== false;
          return (
            <g key={i}>
              <path className={anim ? "e anim" : "e"} d={d} />
              <text className="elab" x={mx} y={(y1 + y2) / 2 - 6} textAnchor="middle">
                {e.label}
              </text>
            </g>
          );
        })}
        {snap.nodes.map((n) => {
          const p = layout.pos.get(n.id);
          if (!p) return null;
          const hot = snap.active.includes(n.id);
          const fill = KIND_COLOR[n.kind] || "#8c99ab";
          return (
            <g key={n.id} transform={`translate(${p.x},${p.y})`}>
              <rect className={`node k-${n.kind}${hot ? " hot" : ""}`} width={p.w} height={p.h} rx={6} />
              <text className="nk" x={10} y={14} fill={fill}>
                {n.kind}
              </text>
              <text className="nlabel" x={10} y={30}>
                {(n.id === "user" ? "User App" : n.label).slice(0, 18)}
              </text>
              {n.sub ? (
                <text className="nsub" x={10} y={44}>
                  {n.sub.slice(0, 28)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
