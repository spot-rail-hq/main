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
  // Padding tightens only on small phones (≤560), matching the page content —
  // so the logo stays aligned with the content and doesn't jump on tablet.
  const [isSmall, setIsSmall] = React.useState(
    typeof window !== 'undefined' ? window.innerWidth <= 560 : false
  );
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const onResize = () => {
      setIsMobile(window.innerWidth <= 900);
      setIsSmall(window.innerWidth <= 560);
    };
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
                    padding: isSmall ? '14px 20px' : '18px 32px',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    fontFamily: SRHQ.body }}>
        <a href="/" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>
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
      <div style={{ maxWidth: 1280, margin: '0 auto 36px', paddingBottom: 28,
                    borderBottom: `1px solid ${SRHQ.line}`,
                    fontSize: 14, lineHeight: 1.6, color: SRHQ.inkDim }}>
        For general enquiries, please get in touch at{' '}
        <a href="mailto:spotrailhq@gmail.com" style={{
          color: SRHQ.turq, textDecoration: 'none',
          transition: 'opacity .15s ease',
        }}
           onMouseEnter={e => e.currentTarget.style.opacity = '0.75'}
           onMouseLeave={e => e.currentTarget.style.opacity = '1'}>
          spotrailhq@gmail.com
        </a>{' '}— we'd love to hear from you.
      </div>
      <div style={{ maxWidth: 1280, margin: '0 auto',
                    display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 1fr', gap: 32 }}>
        <div>
          <a href="/" style={{ textDecoration: 'none' }}>
            <BrandMark size={15} />
          </a>
          <div style={{ fontSize: 13, marginTop: 12, maxWidth: 280, lineHeight: 1.55 }}>
            An independent resource about the UK railway — rolling stock, operators,
            and the network. Not affiliated with any train operating company.
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11, letterSpacing: 2, textTransform: 'uppercase',
                        color: SRHQ.inkDim, marginBottom: 10 }}>Explore</div>
          {[
            { label: 'Home', href: '/' },
            { label: 'Rolling stock database', href: 'database.html' },
            { label: 'Network map', href: 'map.html' },
          ].map(x =>
            <a key={x.label} href={x.href} style={{
              display: 'block', fontSize: 13.5, marginBottom: 6,
              color: 'inherit', textDecoration: 'none', transition: 'color .15s ease',
            }}
               onMouseEnter={e => e.currentTarget.style.color = SRHQ.turq}
               onMouseLeave={e => e.currentTarget.style.color = 'inherit'}>{x.label}</a>)}
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

// —— GDPR / cookie consent ————————————————————————————————————————
// Vercel-style compact card, bottom-left. Necessary cookies are always on;
// Analytics + Marketing are opt-in. Choice persists in localStorage so the
// banner only shows on a visitor's first visit (or after they reset).
const COOKIE_KEY = 'srhq-cookie-consent.v1';

function CookieConsent() {
  const [visible, setVisible] = React.useState(false);
  const [customizing, setCustomizing] = React.useState(false);
  const [prefs, setPrefs] = React.useState({ analytics: true, marketing: true });

  React.useEffect(() => {
    let stored = null;
    try { stored = localStorage.getItem(COOKIE_KEY); } catch (e) {}
    if (!stored) {
      // Small delay so it slides in after the page settles.
      const t = setTimeout(() => setVisible(true), 600);
      return () => clearTimeout(t);
    }
  }, []);

  const persist = (choice) => {
    try {
      localStorage.setItem(COOKIE_KEY, JSON.stringify({
        necessary: true, ...choice, ts: new Date().toISOString(),
      }));
    } catch (e) {}
    setVisible(false);
  };

  const acceptAll = () => persist({ analytics: true, marketing: true });
  const rejectAll = () => persist({ analytics: false, marketing: false });
  const savePrefs = () => persist(prefs);

  if (!visible) return null;

  const categories = [
    { key: 'necessary', label: 'Strictly necessary', locked: true,
      desc: 'Required for the site to function. Always on.' },
    { key: 'analytics', label: 'Analytics',
      desc: 'Helps us understand which pages and routes get used.' },
    { key: 'marketing', label: 'Marketing',
      desc: 'Used to measure the reach of anything we share.' },
  ];

  const btnBase = {
    fontFamily: SRHQ.body, fontSize: 13, fontWeight: 600, cursor: 'pointer',
    borderRadius: 10, padding: '9px 14px', lineHeight: 1, transition: 'all .15s ease',
    border: '1px solid transparent', whiteSpace: 'nowrap',
  };
  const primaryBtn = { ...btnBase, background: SRHQ.turq, color: SRHQ.bg, border: 'none' };
  const ghostBtn = {
    ...btnBase, background: 'transparent', color: SRHQ.ink,
    border: `1px solid ${SRHQ.lineStrong}`,
  };
  const hoverPrimary = e => { e.currentTarget.style.filter = 'brightness(1.08)'; };
  const unhoverPrimary = e => { e.currentTarget.style.filter = 'none'; };
  const hoverGhost = e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
                            e.currentTarget.style.borderColor = SRHQ.turq + '66'; };
  const unhoverGhost = e => { e.currentTarget.style.background = 'transparent';
                              e.currentTarget.style.borderColor = SRHQ.lineStrong; };

  return ReactDOM.createPortal(
    <div role="dialog" aria-label="Cookie consent" style={{
      position: 'fixed', left: 20, bottom: 20, zIndex: 2000,
      width: 'min(400px, calc(100vw - 40px))',
      background: SRHQ.surface, border: `1px solid ${SRHQ.line}`,
      borderRadius: 16, padding: 20, fontFamily: SRHQ.body, color: SRHQ.ink,
      boxShadow: '0 24px 70px rgba(0,0,0,0.6), 0 0 0 1px rgba(64,224,208,0.06) inset',
      animation: 'srhqCookieIn .35s cubic-bezier(.16,.84,.44,1)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: SRHQ.turq,
                        boxShadow: `0 0 0 4px ${SRHQ.turq}22`, flexShrink: 0 }} />
        <span style={{ fontFamily: SRHQ.mono, fontSize: 10.5, letterSpacing: 2,
                        textTransform: 'uppercase', color: SRHQ.inkMute }}>Cookies</span>
      </div>

      <p style={{ fontSize: 13.5, lineHeight: 1.6, color: SRHQ.inkDim, margin: '0 0 16px' }}>
        We use cookies to deliver and improve SpotRail HQ and to understand how the
        site is used. You can accept all, reject non-essential, or choose what you
        allow. See our{' '}
        <a href="#" style={{ color: SRHQ.turq, textDecoration: 'none',
                             borderBottom: `1px solid ${SRHQ.turq}44` }}>cookie policy</a>.
      </p>

      {customizing && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2,
                      margin: '0 0 16px', borderTop: `1px solid ${SRHQ.line}`,
                      paddingTop: 6 }}>
          {categories.map(c => {
            const on = c.locked ? true : prefs[c.key];
            return (
              <div key={c.key} style={{ display: 'flex', alignItems: 'flex-start',
                                        gap: 12, padding: '10px 0',
                                        borderBottom: `1px solid ${SRHQ.line}` }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: SRHQ.ink }}>{c.label}</div>
                  <div style={{ fontSize: 12, color: SRHQ.inkMute, marginTop: 2,
                                lineHeight: 1.5 }}>{c.desc}</div>
                </div>
                <button
                  onClick={() => !c.locked && setPrefs(p => ({ ...p, [c.key]: !p[c.key] }))}
                  aria-label={`Toggle ${c.label}`}
                  disabled={c.locked}
                  style={{
                    flexShrink: 0, marginTop: 2, width: 38, height: 22, borderRadius: 999,
                    border: 'none', padding: 2, cursor: c.locked ? 'default' : 'pointer',
                    background: on ? SRHQ.turq : 'rgba(255,255,255,0.14)',
                    opacity: c.locked ? 0.55 : 1, transition: 'background .15s ease',
                    display: 'flex', justifyContent: on ? 'flex-end' : 'flex-start',
                  }}>
                  <span style={{ width: 18, height: 18, borderRadius: '50%',
                                  background: on ? SRHQ.bg : '#E8ECF2',
                                  transition: 'all .15s ease' }} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {!customizing ? (
          <>
            <button style={primaryBtn} onClick={acceptAll}
                    onMouseEnter={hoverPrimary} onMouseLeave={unhoverPrimary}>Accept all</button>
            <button style={ghostBtn} onClick={rejectAll}
                    onMouseEnter={hoverGhost} onMouseLeave={unhoverGhost}>Reject all</button>
            <button style={{ ...ghostBtn, marginLeft: 'auto' }} onClick={() => setCustomizing(true)}
                    onMouseEnter={hoverGhost} onMouseLeave={unhoverGhost}>Customize</button>
          </>
        ) : (
          <>
            <button style={primaryBtn} onClick={savePrefs}
                    onMouseEnter={hoverPrimary} onMouseLeave={unhoverPrimary}>Save preferences</button>
            <button style={ghostBtn} onClick={acceptAll}
                    onMouseEnter={hoverGhost} onMouseLeave={unhoverGhost}>Accept all</button>
          </>
        )}
      </div>

      <style>{`
        @keyframes srhqCookieIn {
          from { opacity: 0; transform: translateY(16px) scale(.98); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>,
    document.body
  );
}

Object.assign(window, { SRHQ, CAT, BrandMark, TopNav, Footer, CookieConsent });
