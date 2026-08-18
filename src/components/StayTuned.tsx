// Site test aşamasındayken solofluck.com kök adresine gelen herkese
// gösterilen, tamamen düz siyah "yakında" sayfası. Gerçek uygulama, config.ts
// içindeki PREVIEW_ACCESS_PATH ile eşleşen gizli bir yol üzerinden açılır
// (bkz. src/main.tsx). Bu bir güvenlik önlemi değil, sadece test aşamasında
// meraklı ziyaretçileri yavaşlatan bir gizleme (obscurity) katmanıdır.
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
