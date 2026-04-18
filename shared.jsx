// Shared design system for SpotRail HQ.
// Modern, minimal. Black background; turquoise primary; sharp accents used sparingly.

const SRHQ = {
  // Palette
  bg: '#07090C',           // near-black
  surface: '#0E1218',      // raised surface
  surface2: '#141922',
  line: 'rgba(255,255,255,0.08)',
  lineStrong: 'rgba(255,255,255,0.16)',
  ink: '#E8ECF2',
  inkDim: '#9AA4B2',
  inkMute: '#6B7687',

  turq: '#40E0D0',
  magenta: '#F25CC1',
  amber: '#F5B84B',
  lime: '#B8F266',
  coral: '#FF7A6B',
  violet: '#9D7CFF',

  // Fonts
  display: 'Archivo, system-ui, sans-serif',
  body: 'Manrope, system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, monospace',
};

// Category → accent color map (stable across pages)
const CAT = {
  'Intercity & High Speed':  { key: 'intercity',   color: '#40E0D0', short: 'Intercity'  },
  'Regional Passenger':      { key: 'regional',    color: '#B8F266', short: 'Regional'   },
  'Commuter & Suburban':     { key: 'commuter',    color: '#F25CC1', short: 'Commuter'   },
  'Freight':                 { key: 'freight',     color: '#F5B84B', short: 'Freight'    },
  'Charter & Railtours':     { key: 'charter',     color: '#FF7A6B', short: 'Charter'    },
  'Light Rail & Metro':      { key: 'metro',       color: '#9D7CFF', short: 'Metro'      },
  'Heritage & Preserved':    { key: 'heritage',    color: '#8AA0B4', short: 'Heritage'   },
};

// Logo placeholder — text-only wordmark (user will design the real one)
function BrandMark({ size = 18, accent = SRHQ.turq }) {
  return (
    <span style={{
      fontFamily: SRHQ.display, fontWeight: 700, fontSize: size,
      letterSpacing: -0.6, color: SRHQ.ink, display: 'inline-flex',
      alignItems: 'center', gap: 10,
    }}>
      <svg width={size * 1.3} height={size * 1.3} viewBox="0 0 28 28">
        <rect width="28" height="28" rx="7" fill={accent} />
        <path d="M7 8 h10 a3 3 0 0 1 0 6 h-6 a3 3 0 0 0 0 6 h10"
              stroke={SRHQ.bg} strokeWidth="3" fill="none" strokeLinecap="round" />
      </svg>
      SpotRail<span style={{ color: SRHQ.inkDim, marginLeft: '0.25em' }}>HQ</span>
    </span>
  );
}

function TopNav({ current }) {
  const items = [
    { href: 'index.html',   label: 'Home' },
    { href: 'database.html', label: 'Database' },
    { href: 'map.html',      label: 'Network map' },
  ];
  return (
    <nav style={{
      position: 'sticky', top: 0, zIndex: 50, background: 'rgba(7,9,12,0.8)',
      backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
      borderBottom: `1px solid ${SRHQ.line}`,
    }}>
      <div style={{ maxWidth: 1280, margin: '0 auto', padding: '18px 32px',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    fontFamily: SRHQ.body }}>
        <a href="index.html" style={{ textDecoration: 'none' }}>
          <BrandMark size={17} />
        </a>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {items.map(i => {
            const on = i.href === current;
            return (
              <a key={i.href} href={i.href} style={{
                padding: '8px 14px', borderRadius: 999,
                fontSize: 13.5, fontWeight: 500,
                color: on ? SRHQ.bg : SRHQ.ink, textDecoration: 'none',
                background: on ? SRHQ.turq : 'transparent',
                border: on ? 'none' : `1px solid transparent`,
                transition: 'all .15s ease',
              }} onMouseEnter={e => { if (!on) e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
                 onMouseLeave={e => { if (!on) e.currentTarget.style.background = 'transparent'; }}>
                {i.label}
              </a>
            );
          })}
        </div>
      </div>
    </nav>
  );
}

function Footer() {
  return (
    <footer style={{
      borderTop: `1px solid ${SRHQ.line}`, marginTop: 80,
      padding: '44px 32px 56px', fontFamily: SRHQ.body, color: SRHQ.inkMute,
    }}>
      <div style={{ maxWidth: 1280, margin: '0 auto',
                    display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 1fr', gap: 32 }}>
        <div>
          <BrandMark size={15} />
          <div style={{ fontSize: 13, marginTop: 12, maxWidth: 280, lineHeight: 1.55 }}>
            An independent resource about the UK railway — rolling stock, operators,
            and the network. Not affiliated with any train operating company.
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11, letterSpacing: 2, textTransform: 'uppercase',
                        color: SRHQ.inkDim, marginBottom: 10 }}>Explore</div>
          {['Rolling stock database', 'Network map', 'Operators'].map(x =>
            <div key={x} style={{ fontSize: 13.5, marginBottom: 6 }}>{x}</div>)}
        </div>
        <div>
          <div style={{ fontSize: 11, letterSpacing: 2, textTransform: 'uppercase',
                        color: SRHQ.inkDim, marginBottom: 10 }}>Coming soon</div>
          {['Live departures', 'Community', 'Journey planner'].map(x =>
            <div key={x} style={{ fontSize: 13.5, marginBottom: 6 }}>{x}</div>)}
        </div>
        <div>
          <div style={{ fontSize: 11, letterSpacing: 2, textTransform: 'uppercase',
                        color: SRHQ.inkDim, marginBottom: 10 }}>Data</div>
          <div style={{ fontSize: 13.5, marginBottom: 6 }}>Verified April 2026</div>
          <div style={{ fontSize: 13.5, marginBottom: 6 }}>Wikipedia · operator websites</div>
        </div>
      </div>
      <div style={{ maxWidth: 1280, margin: '32px auto 0',
                    fontSize: 12, color: SRHQ.inkMute,
                    display: 'flex', justifyContent: 'space-between',
                    borderTop: `1px solid ${SRHQ.line}`, paddingTop: 20 }}>
        <span>© 2026 SpotRail HQ</span>
        <span style={{ fontFamily: SRHQ.mono }}>v0.1 · phase 1</span>
      </div>
    </footer>
  );
}

Object.assign(window, { SRHQ, CAT, BrandMark, TopNav, Footer });
