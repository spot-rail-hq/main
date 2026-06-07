// Central Shared Design Directives for SpotRail HQ
const SRHQ = {
  turq: '#40E0D0',
  surface: '#0E1218',
  line: 'rgba(255, 255, 255, 0.08)',
  ink: '#E8ECF2',
  inkDim: '#9AA4B2',
  inkMute: '#6B7687',
  display: 'Archivo, system-ui, sans-serif',
  body: 'Manrope, system-ui, sans-serif',
  mono: '"JetBrains Mono", monospace'
};

function TopNav({ current }) {
  return (
    <nav style={{ background: '#07090C', borderBottom: `1px solid ${SRHQ.line}`, padding: '16px 32px' }}>
      <div style={{ maxWidth: 1220, margin: '0 auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontFamily: SRHQ.display, fontWeight: 700, fontSize: 18, letterSpacing: -0.5 }}>
          SpotRail<span style={{ color: SRHQ.turq }}>HQ</span>
        </div>
        <div style={{ display: 'flex', gap: 24, fontFamily: SRHQ.body, fontSize: 14, fontWeight: 500 }}>
          <span style={{ color: current === 'map.html' ? SRHQ.turq : SRHQ.inkDim, cursor: 'default' }}>Network Map</span>
          <a href="#" style={{ textDecoration: 'none', color: SRHQ.inkDim }}>Database</a>
        </div>
      </div>
    </nav>
  );
}

function Footer() {
  return (
    <footer style={{ background: '#07090C', borderTop: `1px solid ${SRHQ.line}`, padding: '40px 32px', marginTop: 60 }}>
      <div style={{ maxWidth: 1220, margin: '0 auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 20, fontFamily: SRHQ.body, fontSize: 13, color: SRHQ.inkMute }}>
        <div>&copy; 2026 SpotRail HQ. All rights reserved.</div>
        <div style={{ display: 'flex', gap: 16 }}>
          <a href="#" style={{ textDecoration: 'none' }}>Privacy</a>
          <a href="#" style={{ textDecoration: 'none' }}>Terms</a>
        </div>
      </div>
    </footer>
  );
}