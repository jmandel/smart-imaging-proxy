// The timeline: one lane per party, events counted in equal bins of time, with denials and failures on top of
// each bar. It's drawn to the width it has, and redrawn when that changes.
import { useEffect, useRef, useState } from "react";
import { plural } from "../lib/format";
import { time } from "../lib/event-words";

export interface TimelineData { from: number; to: number; bins: number; lanes: { party: string; counts: number[]; problems: number[] }[] }
export const PARTY: Record<string, string> = { "authorization-server": "Authorization Server", "imaging-fhir": "Imaging Server", policy: "Imaging Server policy", "dicomweb-proxy": "Proxy", app: "App" };
const num = (n: number) => n.toLocaleString();
const sum = (list: number[]) => list.reduce((a, b) => a + b, 0);

/** The figure's width, as laid out. */
function useWidth() {
  const ref = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current!;
    const seen = new ResizeObserver(() => setWidth(Math.round(el.clientWidth)));
    seen.observe(el);
    return () => seen.disconnect();
  }, []);
  return [ref, width] as const;
}

export function Timeline({ tl }: { tl: TimelineData }) {
  const [ref, measured] = useWidth();
  const width = Math.max(300, measured), label = width < 480 ? 92 : 150, right = 44;
  const laneH = 38, top = 8, plotW = width - label - right, step = plotW / tl.bins, bar = Math.max(1, Math.min(10, step - 2));
  const max = Math.max(1, ...tl.lanes.flatMap(l => l.counts));
  const h = top + tl.lanes.length * laneH + 26;
  const span = tl.to - tl.from;
  const fmt = (at: number) => span > 864e5 ? new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : time(at);
  const binText = (i: number) => `${fmt(tl.from + i * span / tl.bins)} to ${fmt(tl.from + (i + 1) * span / tl.bins)}`;
  const axisY = top + tl.lanes.length * laneH + 14;
  return (
    <figure className="timeline" id="timeline" ref={ref}>
      <figcaption><span>Events over time, by party</span><span className="tl-key"><i className="k-ok" />events <i className="k-bad" />denied or failed</span></figcaption>
      {/* Until it's measured, the figure holds its height and draws nothing, so nothing is drawn wider than it. */}
      {!measured ? <div style={{ height: h }} /> : <svg width={width} height={h} viewBox={`0 0 ${width} ${h}`} role="img" aria-labelledby="tl-title tl-desc">
        <title id="tl-title">Events over time, by party, from {fmt(tl.from)} to {fmt(tl.to)}</title>
        <desc id="tl-desc">{tl.lanes.map(l => `${PARTY[l.party]}: ${sum(l.counts)}`).join(", ")}</desc>
        {tl.lanes.map((l, li) => {
          const base = top + (li + 1) * laneH - 6;
          return (
            <g key={l.party}>
              <text className="tl-lane" x="0" y={base - 4}>{PARTY[l.party]}</text>
              <line className="tl-base" x1={label} x2={label + plotW} y1={base + .5} y2={base + .5} />
              {l.counts.map((n, i) => {
                if (!n) return null;
                const bad = l.problems[i] ?? 0;
                const x = label + i * step + (step - bar) / 2, hh = Math.max(2, (n / max) * (laneH - 10)), badH = bad ? Math.max(2, (bad / n) * hh) : 0;
                return (
                  <g key={i}>
                    <title>{`${PARTY[l.party]}, ${binText(i)}: ${plural(n, "event")}${bad ? `, ${bad} denied or failed` : ""}`}</title>
                    <rect className="tl-bar" x={x.toFixed(1)} y={(base - hh).toFixed(1)} width={bar.toFixed(1)} height={Math.max(0, hh - (badH ? badH + 1 : 0)).toFixed(1)} rx="1" />
                    {badH > 0 && <rect className="tl-bad" x={x.toFixed(1)} y={(base - hh).toFixed(1)} width={bar.toFixed(1)} height={badH.toFixed(1)} rx="1" />}
                  </g>
                );
              })}
              <text className="tl-total" x={width} y={base - 4} textAnchor="end">{num(sum(l.counts))}</text>
            </g>
          );
        })}
        <text className="tl-axis" x={label} y={axisY}>{fmt(tl.from)}</text>
        {plotW > 260 && <text className="tl-axis" x={label + plotW / 2} y={axisY} textAnchor="middle">{fmt(tl.from + span / 2)}</text>}
        <text className="tl-axis" x={label + plotW} y={axisY} textAnchor="end">{fmt(tl.to)}</text>
      </svg>}
    </figure>
  );
}
