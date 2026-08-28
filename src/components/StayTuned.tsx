// The entirely plain black "coming soon" page shown to everyone who arrives at
// the solofluck.com root while the site is in testing. The real app opens
// through a hidden path matching PREVIEW_ACCESS_PATH in config.ts (see
// src/main.tsx). This is not a security measure, only a layer of obscurity that
// slows down curious visitors during testing.
export function StayTuned() {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: '#000',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <span
        style={{
          color: '#fff',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          fontSize: 'clamp(2rem, 8vw, 5rem)',
          fontWeight: 800,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
        }}
      >
        Stay Tuned
      </span>
    </div>
  )
}
