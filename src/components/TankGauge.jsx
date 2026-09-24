// src/components/TankGauge.jsx
//
// Illustrated gauge shaped like the overhead tanks farmers actually have
// (domed cap, cylindrical body, stand) instead of a plain FULL/EMPTY text
// block. V1 only has a binary reading (IR sensor at the full mark), so the
// liquid snaps to a near-full or near-thin level rather than a smoothly
// animated percentage; V2 (ToF sensor) can pass a real 0-100 level into
// the same component without changing callers.

import { useId } from 'react';

const COLOR_FULL = 'var(--color-success)';
const COLOR_EMPTY = 'var(--color-danger)';
const COLOR_UNKNOWN = 'var(--color-muted)';

export default function TankGauge({ level = 'unknown', online = true, size = 40 }) {
  const rawId = useId();
  const clipId = `tank-gauge-clip-${rawId.replace(/[^a-zA-Z0-9]/g, '')}`;

  // A reading exists whether or not the device is online right now; offline
  // just makes it stale, so the shape still shows the last known level
  // (muted + dashed) instead of going blank. Only "no reading yet" (level
  // is neither full nor empty) shows the "?" placeholder.
  const hasReading = level === 'full' || level === 'empty';
  const stale = hasReading && !online;
  const known = hasReading;
  const color = !hasReading ? COLOR_UNKNOWN : stale ? COLOR_UNKNOWN : level === 'full' ? COLOR_FULL : COLOR_EMPTY;
  const dashed = !hasReading || stale;
  // Interior fill band: y 44 (top) to 134 (tank floor).
  const liquidTop = level === 'full' ? 44 : 116;
  const liquidBottom = 134;

  return (
    <svg
      width={size}
      height={size * (160 / 120)}
      viewBox="0 0 120 160"
      role="img"
      aria-label={known ? (level === 'full' ? 'Tank full' : 'Tank empty') : 'Tank status unknown'}
    >
      <defs>
        <clipPath id={clipId}>
          <path d="M20,50 A40,26 0 0,1 100,50 L100,124 A40,14 0 0,1 20,124 Z" />
        </clipPath>
      </defs>

      {/* body */}
      <path
        d="M20,50 A40,26 0 0,1 100,50 L100,124 A40,14 0 0,1 20,124 Z"
        fill="var(--color-card)"
        stroke={color}
        strokeWidth="4"
        strokeDasharray={dashed ? '6 6' : undefined}
      />

      {/* inlet cap */}
      <rect x="52" y="14" width="16" height="10" rx="2" fill="var(--color-card)" stroke={color} strokeWidth="4" strokeDasharray={dashed ? '4 3' : undefined} />
      <line x1="60" y1="24" x2="60" y2="34" stroke={color} strokeWidth="4" />

      {/* liquid: shown for any reading, even a stale (offline) one */}
      {hasReading && (
        <g clipPath={`url(#${clipId})`}>
          <rect x="16" y={liquidTop} width="88" height={liquidBottom - liquidTop + 20} fill={color} opacity={stale ? 0.55 : 0.85} />
          <path d={`M16,${liquidTop} q10,-6 20,0 t20,0 t20,0 t20,0 v6 h-80 Z`} fill={color} opacity={stale ? 0.3 : 0.5} />
        </g>
      )}
      {!hasReading && (
        <text x="60" y="96" fontSize="26" textAnchor="middle" fill={color} opacity="0.8">?</text>
      )}

      {/* stand */}
      <path d="M28,124 L18,146 L102,146 L92,124 Z" fill="none" stroke={color} strokeWidth="4" strokeLinejoin="round" strokeDasharray={dashed ? '6 6' : undefined} />
    </svg>
  );
}