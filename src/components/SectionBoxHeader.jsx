// src/components/SectionBoxHeader.jsx
//
// Shared header for each of the 4 Home boxes (Cattle/Crop/IoT/Pond).
// REDESIGNED as a stacked 3-row layout (icon / title+toggle / Add
// button) instead of one wide flex row - the original single-row
// version was built for the old full-width panels and broke once the
// Home 2x2 grid put each box in a ~half-width column: "IoT Devices (0)"
// plus a "+ Add Device" pill simply don't fit on one line at that
// width, which is what caused the text-wrap collisions and clipped
// buttons in the on-device screenshot. This stacked layout is the one
// the original Gemini mockup showed (icon on top, bold title+count,
// toggle arrow and Add pill on their own row) and is narrow-safe by
// construction - nothing sits side-by-side that has to compete for
// horizontal space.
//
// `onAdd` is optional - pass undefined (not a no-op function) to hide
// the add button entirely.

export default function SectionBoxHeader({ icon, title, count, isOpen, onToggle, onAdd, addLabel }) {
  return (
    <div style={{ padding: '14px 14px 10px' }}>
      <div style={{ fontSize: 22, lineHeight: 1, marginBottom: 6 }}>{icon}</div>

      <button
        onClick={onToggle}
        style={{
          width: '100%',
          padding: 0,
          border: 'none',
          background: 'transparent',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: 16,
          fontWeight: 700,
          color: 'var(--color-ink)',
          marginBottom: onAdd ? 10 : 0,
        }}
      >
        <span className="display-text">{title} ({count})</span>
        <span style={{ fontSize: 14, color: 'var(--color-muted)', flexShrink: 0, marginLeft: 8 }}>
          {isOpen ? '^' : 'v'}
        </span>
      </button>

      {onAdd && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onAdd();
          }}
          style={{
            width: '100%',
            padding: '9px 10px',
            borderRadius: 10,
            border: 'none',
            background: 'var(--color-gold)',
            color: 'var(--color-navy)',
            fontWeight: 700,
            fontSize: 13,
          }}
        >
          {addLabel}
        </button>
      )}
    </div>
  );
}