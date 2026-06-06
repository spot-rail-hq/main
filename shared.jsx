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
    { href: 'database.html', label: 'Database' },
    { href: 'map.html',      label: 'Network map' },
  ];
  const [isMobile, setIsMobile] = React.useState(
    typeof window !== 'undefined' ? window.innerWidth <= 900 : false
  );
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= 900);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Lock body scroll when drawer is open
  React.useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  return (
    <>
    <nav style={{
      position: 'sticky', top: 0, zIndex: 50, background: 'rgba(7,9,12,0.8)',
      backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
      borderBottom: `1px solid ${SRHQ.line}`,
    }}>
      <div style={{ maxWidth: 1280, margin: '0 auto',
                    padding: isMobile ? '14px 20px' : '18px 32px',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    fontFamily: SRHQ.body }}>
        <a href="index.html" style={{ textDecoration: 'none' }}>
          <BrandMark size={17} />
        </a>

        {/* Desktop nav */}
        {!isMobile && (
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
        )}

        {/* Mobile hamburger */}
        {isMobile && (
          <button onClick={() => setOpen(true)} aria-label="Open menu" style={{
            background: 'transparent', border: `1px solid ${SRHQ.line}`,
            borderRadius: 10, width: 40, height: 40, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: SRHQ.ink,
          }}>
            <svg width="18" height="14" viewBox="0 0 18 14" fill="none">
              <path d="M1 1 H17 M1 7 H17 M1 13 H17" stroke="currentColor"
                    strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
    </nav>

      {/* Mobile drawer — rendered as sibling of <nav> so its fixed-positioned
          children aren't contained by nav's backdrop-filter. */}
      {isMobile && open && ReactDOM.createPortal(
        <>
          <div onClick={() => setOpen(false)} style={{
            position: 'fixed', inset: 0, background: 'rgba(7,9,12,0.6)',
            zIndex: 100, animation: 'srhqFade .2s ease-out',
          }} />
          <aside style={{
            position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(80vw, 320px)',
            background: SRHQ.surface, borderLeft: `1px solid ${SRHQ.line}`,
            zIndex: 101, padding: '20px 22px', display: 'flex', flexDirection: 'column',
            fontFamily: SRHQ.body, boxShadow: '-20px 0 60px rgba(0,0,0,0.5)',
            animation: 'srhqSlide .25s ease-out',
          }}>
            <div style={{ display: 'flex', alignItems: 'center',
                          justifyContent: 'space-between', marginBottom: 28 }}>
              <span style={{ fontFamily: SRHQ.mono, fontSize: 10, letterSpacing: 2,
                              textTransform: 'uppercase', color: SRHQ.inkMute }}>Menu</span>
              <button onClick={() => setOpen(false)} aria-label="Close menu" style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                color: SRHQ.inkDim, fontSize: 22, lineHeight: 1, padding: 4,
              }}>×</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {items.map(i => {
                const on = i.href === current;
                return (
                  <a key={i.href} href={i.href} onClick={() => setOpen(false)} style={{
                    padding: '14px 16px', borderRadius: 12,
                    fontSize: 16, fontWeight: 500,
                    color: on ? SRHQ.turq : SRHQ.ink, textDecoration: 'none',
                    background: on ? `${SRHQ.turq}14` : 'transparent',
                    border: `1px solid ${on ? SRHQ.turq + '44' : 'transparent'}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  }}>
                    <span>{i.label}</span>
                    <span style={{ fontFamily: SRHQ.mono, fontSize: 11,
                                    color: on ? SRHQ.turq : SRHQ.inkMute }}>→</span>
                  </a>
                );
              })}
            </div>
            <div style={{ marginTop: 'auto', paddingTop: 24,
                          borderTop: `1px solid ${SRHQ.line}`,
                          fontSize: 12, color: SRHQ.inkMute, lineHeight: 1.6 }}>
              An independent UK railway resource.<br/>
              <span style={{ fontFamily: SRHQ.mono }}>v0.1 · phase 1</span>
            </div>
          </aside>
          <style>{`
            @keyframes srhqSlide { from { transform: translateX(100%); } to { transform: translateX(0); } }
            @keyframes srhqFade { from { opacity: 0; } to { opacity: 1; } }
          `}</style>
        </>,
        document.body
      )}
    </>
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
