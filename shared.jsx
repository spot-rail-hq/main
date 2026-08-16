// Shared design system for SpotRail HQ.
// Modern, minimal. Black background; turquoise primary; sharp accents used sparingly.

const SRHQ = {
  // Palette (theme-aware via CSS custom properties — see :root in each page's <style>)
  bg: 'var(--bg)',
  surface: 'var(--surface)',
  surface2: 'var(--surface2)',
  line: 'rgba(var(--line-rgb),0.08)',
  lineStrong: 'rgba(var(--line-rgb),0.16)',
  ink: 'var(--ink)',
  inkDim: 'var(--ink-dim)',
  inkMute: 'var(--ink-mute)',

  turq: 'var(--color-accent-turquoise)',
  magenta: 'var(--color-accent-magenta)',
  amber: 'var(--color-accent-amber)',
  lime: 'var(--color-accent-lime)',
  coral: '#FF7A6B',
  violet: '#9D7CFF',

  // Fonts
  display: 'Archivo, system-ui, sans-serif',
  body: 'Manrope, system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, monospace',
};

// Theme (light/dark) — persisted to localStorage, mirrors the inline
// FOUC-prevention script in each page's <head>.
function getInitialTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function toggleTheme() {
  var html = document.documentElement;
  if (html.getAttribute('data-theme') === 'light') {
    html.removeAttribute('data-theme');
    localStorage.setItem('srhq-theme', 'dark');
  } else {
    html.setAttribute('data-theme', 'light');
    localStorage.setItem('srhq-theme', 'light');
  }
  window.dispatchEvent(new Event('srhq-theme-change'));
}

// React hook: re-renders when the theme is toggled.
function useTheme() {
  const [theme, setTheme] = React.useState(getInitialTheme());
  React.useEffect(() => {
    const onChange = () => setTheme(getInitialTheme());
    window.addEventListener('srhq-theme-change', onChange);
    return () => window.removeEventListener('srhq-theme-change', onChange);
  }, []);
  return theme;
}

// Logo path for the current theme (dark default, light variant when toggled).
function logoSrc(theme) {
  return theme === 'light' ? 'img/srhq-logo-light.svg' : 'img/srhq-logo.svg';
}

// Appends an alpha value to a color token. Raw hex colors get a hex8 suffix
// (unchanged legacy behaviour); var(--x) tokens become rgba(var(--x-rgb), n)
// so accent colors that are now theme-aware CSS custom properties keep
// working with alpha transparency.
function colorAlpha(value, alphaHex) {
  const m = /^var\((--[\w-]+)\)$/.exec(value);
  if (!m) return value + alphaHex;
  const alpha = Math.round((parseInt(alphaHex, 16) / 255) * 100) / 100;
  return `rgba(var(${m[1]}-rgb),${alpha})`;
}

// regionKeyFor(station) — the ONE place that turns a station object (the
// station-list.json shape: {name, crs, atco, mode, network, lat, lon}) into
// the key used to look it up in data/station-regions.json's `current` map.
// Prefers the station's own `atco` (present for 3,436 of 3,443 stations);
// falls back to the `crs:<CODE>` namespaced key for the remainder, which
// carry `atco: null` on their own station-list.json row (see CLAUDE.md's
// station-regions note — Bond Street, Barking Riverside, Custom House,
// Canary Wharf, Tottenham Court Road, Woolwich, Southampton Town Quay).
// The `crs:` prefix can never collide with a real atco, which always starts
// with a 4-digit numeric prefix.
//
// Every consumer of station-regions.json (map.html today; Stations/Routes
// once they exist) must resolve through this one function rather than
// re-deriving the atco-vs-crs fallback locally — see
// scripts/tests/station-region-harness.mjs, which slices this exact
// function out of this file and asserts all 3,443 current stations resolve.
function regionKeyFor(station) {
  if (!station) return null;
  if (station.atco) return station.atco;
  if (station.crs) return 'crs:' + station.crs;
  return null;
}

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
    { href: '/news',       label: 'News' },
    { href: '/departures', label: 'Live Departures' },
    { href: '/database',   label: 'Database' },
    { href: '/map',        label: 'Network Map' },
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
  const theme = useTheme();

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
      position: 'sticky', top: 0, zIndex: 50, background: 'rgba(var(--bg-rgb),0.8)',
      backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
      borderBottom: `1px solid ${SRHQ.line}`,
    }}>
      <div style={{ maxWidth: 1280, margin: '0 auto',
                    padding: isSmall ? '14px 20px' : '18px 32px',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    fontFamily: SRHQ.body }}>
        <a href="/" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>
          <img src={logoSrc(theme)} alt="SpotRail HQ" style={{ display: 'block', height: 40, width: 'auto', maxWidth: 320 }} />
        </a>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
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
                  }} onMouseEnter={e => { if (!on) e.currentTarget.style.background = 'rgba(var(--line-rgb),0.06)'; }}
                     onMouseLeave={e => { if (!on) e.currentTarget.style.background = 'transparent'; }}>
                    {i.label}
                  </a>
                );
              })}
            </div>
          )}

          {/* Theme toggle */}
          <button className="theme-toggle" onClick={toggleTheme} aria-label="Toggle color theme">
            <svg className="icon-sun" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="5"/>
              <line x1="12" y1="1" x2="12" y2="3"/>
              <line x1="12" y1="21" x2="12" y2="23"/>
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
              <line x1="1" y1="12" x2="3" y2="12"/>
              <line x1="21" y1="12" x2="23" y2="12"/>
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
            </svg>
            <svg className="icon-moon" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
            </svg>
          </button>

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
      </div>
    </nav>

      {/* Mobile drawer — rendered as sibling of <nav> so its fixed-positioned
          children aren't contained by nav's backdrop-filter. */}
      {isMobile && open && ReactDOM.createPortal(
        <>
          <div onClick={() => setOpen(false)} style={{
            position: 'fixed', inset: 0, background: 'rgba(var(--bg-rgb),0.6)',
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
                    background: on ? colorAlpha(SRHQ.turq, '14') : 'transparent',
                    border: `1px solid ${on ? colorAlpha(SRHQ.turq, '44') : 'transparent'}`,
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
  const theme = useTheme();
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
          <a href="/" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>
            <img src={logoSrc(theme)} alt="SpotRail HQ" style={{ display: 'block', height: 40, width: 'auto', maxWidth: 320 }} />
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
            { label: 'News', href: '/news' },
            { label: 'Live Departures', href: '/departures' },
            { label: 'Rolling stock database', href: '/database' },
            { label: 'Network map', href: '/map' },
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
          {['Community', 'Journey planner'].map(x =>
            <div key={x} style={{ fontSize: 13.5, marginBottom: 6 }}>{x}</div>)}
        </div>
        <div>
          <div style={{ fontSize: 11, letterSpacing: 2, textTransform: 'uppercase',
                        color: SRHQ.inkDim, marginBottom: 10 }}>Data</div>
          <div style={{ fontSize: 13.5, marginBottom: 6 }}>Verified June 2026</div>
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
  const hoverGhost = e => { e.currentTarget.style.background = 'rgba(var(--line-rgb),0.06)';
                            e.currentTarget.style.borderColor = colorAlpha(SRHQ.turq, '66'); };
  const unhoverGhost = e => { e.currentTarget.style.background = 'transparent';
                              e.currentTarget.style.borderColor = SRHQ.lineStrong; };

  return ReactDOM.createPortal(
    <div role="dialog" aria-label="Cookie consent" style={{
      position: 'fixed', left: 20, bottom: 20, zIndex: 2000,
      width: 'min(400px, calc(100vw - 40px))',
      background: SRHQ.surface, border: `1px solid ${SRHQ.line}`,
      borderRadius: 16, padding: 20, fontFamily: SRHQ.body, color: SRHQ.ink,
      boxShadow: '0 24px 70px rgba(0,0,0,0.6), 0 0 0 1px rgba(var(--color-accent-turquoise-rgb),0.06) inset',
      animation: 'srhqCookieIn .35s cubic-bezier(.16,.84,.44,1)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: SRHQ.turq,
                        boxShadow: `0 0 0 4px ${colorAlpha(SRHQ.turq, '22')}`, flexShrink: 0 }} />
        <span style={{ fontFamily: SRHQ.mono, fontSize: 10.5, letterSpacing: 2,
                        textTransform: 'uppercase', color: SRHQ.inkMute }}>Cookies</span>
      </div>

      <p style={{ fontSize: 13.5, lineHeight: 1.6, color: SRHQ.inkDim, margin: '0 0 16px' }}>
        We use cookies to deliver and improve SpotRail HQ and to understand how the
        site is used. You can accept all, reject non-essential, or choose what you
        allow. See our{' '}
        <a href="#" style={{ color: SRHQ.turq, textDecoration: 'none',
                             borderBottom: `1px solid ${colorAlpha(SRHQ.turq, '44')}` }}>cookie policy</a>.
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
                    background: on ? SRHQ.turq : 'rgba(var(--line-rgb),0.14)',
                    opacity: c.locked ? 0.55 : 1, transition: 'background .15s ease',
                    display: 'flex', justifyContent: on ? 'flex-end' : 'flex-start',
                  }}>
                  <span style={{ width: 18, height: 18, borderRadius: '50%',
                                  background: on ? SRHQ.bg : 'var(--ink)',
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

// ═══════════════════════════════════════════════════════════════════════
// DatasetExplorer — generic filterable/groupable dataset browser
// ═══════════════════════════════════════════════════════════════════════
// Extracted 2026-08-23 from database.html's rolling-stock UI, which is now
// its first consumer (see database.html's LOCOMOTIVE_CONFIG for the
// reference config). Refactor only — nothing about how that page looks or
// behaves changed; every knob its UI needed became a config field here
// instead of being hardcoded (CAT, tractionKind(), SEARCH_FIELDS, the
// hardcoded Row layout).
//
// Config shape:
// {
//   dataSources: [path, ...],          tried in order; first fetch that
//                                       parses as real JSON AND survives
//                                       adapt() wins — rejects HTML/SPA-
//                                       fallback 200s the same way the old
//                                       useData() did.
//   adapt(json) => { items, groups } | falsy
//                                       raw payload -> a FLAT array of every
//                                       renderable row instance (a class
//                                       cross-listed into two sections
//                                       appears twice, once per instance,
//                                       exactly as data/site-data.json's own
//                                       categories[].classes already does)
//                                       plus one metadata object per group:
//                                       { key, label, subtitle, count }.
//                                       Return a falsy value to reject a
//                                       candidate dataSource and try the
//                                       next one.
//   topNavCurrent: '/database',
//   header: <jsx/>,                    page-specific hero. Rendered only
//                                       once data has loaded — matches the
//                                       original page's err/loading states,
//                                       which never showed it either.
//   loadErrorText, searchPlaceholder, emptyStateText: string,
//   deepLinkPrefix: 'fleet-',          '#'+prefix+id auto-expands + scrolls
//                                       to that row once data has loaded.
//   dedupeKey(item) => string,         identity used for the GLOBAL result
//                                       count, so a class cross-listed into
//                                       two groups is counted once, not
//                                       twice. Defaults to item.domId (fine
//                                       when nothing cross-lists).
//   searchFields: [...],               item fields concatenated + lowercased
//                                       for the free-text search box.
//   collapseThreshold: Infinity,       groups at/below this size default
//                                       open; above it, default collapsed.
//   grouping: {
//     field,                           per-item field holding its group key
//                                       (what adapt() tagged it with).
//     values: [...],                   display order — independent of
//                                       whatever order the data arrives in.
//     shortLabels: { key: 'Short' },   tab text; falls back to the group's
//                                       own data-provided `label`.
//     colors: { key: 'var(--...)' },   dot / accent color per group.
//     allLabel: 'All categories',
//   },
//   chip: {                            secondary per-item classification —
//     field,                           raw field read off each item
//     classify(rawValue) => { label, color },
//     values: ['All', ...],            toolbar filter options, IN ORDER —
//                                       values[0] is the "no filter" state.
//     colors: { label: color },
//   } | null,
//   statusFilter: {                    pre-filter row — SHAPE ONLY today.
//     field: null,                     No consumer wires `field` yet, so an
//     values: [],                      empty `values` renders nothing and
//     default: [],                     filters nothing. Stations/Routes both
//   } | null,                          need this concept to exist first.
//   card: {
//     renderImage(item, groupColor, displayName) => <jsx/> | null,
//     summary: {
//       gridTemplate, headers: [{ text, className? }, ...],
//       classField, nameFields: [...], subtitleField,
//       yearFields: [...], speedField, speedFormat(v), speedFallbackField,
//       runnerFields: [...],
//     },
//     left: [fieldDescriptor, ...],
//     right: [fieldDescriptor, ...],
//     full: [fieldDescriptor, ...],    below both columns (e.g. notes).
//   },
// }
//
// A field descriptor: { key, altKey?, label, altLabel?, mono?, multi?,
//   color?, colorFromChip?, format(raw, item)?, link?, derive: 'crossList'? }
// — rendered only when the item has a truthy value for `key` (or falls back
// to `altKey`), except `derive: 'crossList'`, which is computed from
// `grouping` + the item's own `categories` membership instead of a plain
// field.

function firstTruthy(item, fields) {
  for (const f of fields || []) if (item[f]) return item[f];
  return '';
}

// "Also listed under X" — an item can belong to more than one group (its
// own `categories` array, same shape data/site-data.json already produces
// for cross-listed rolling-stock classes). `groupKey` is whichever group
// THIS particular instance is being rendered under, so the same underlying
// item viewed from a different group names whichever OTHER groups it's
// also in.
function crossListLabel(item, groupKey, groupsByKey) {
  const others = (item.categories || []).filter((g) => g !== groupKey);
  if (!others.length) return null;
  const names = others.map((g) => groupsByKey[g] && groupsByKey[g].label).filter(Boolean);
  if (!names.length) return null;
  return `Also listed under ${names.join(' and ')}`;
}

function useDatasetLoader(config) {
  const [data, setData] = React.useState(null);
  const [err, setErr] = React.useState(null);
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const url of config.dataSources) {
        try {
          const r = await fetch(url, { cache: 'no-cache' });
          if (!r.ok) continue;
          const text = await r.text();
          let json;
          try { json = JSON.parse(text); }
          catch (e) { continue; } // got HTML / non-JSON — try the next path
          const adapted = json && config.adapt(json);
          if (adapted && Array.isArray(adapted.items) && Array.isArray(adapted.groups)) {
            if (!cancelled) setData(adapted);
            return;
          }
        } catch (e) { /* network error — try the next candidate */ }
      }
      if (!cancelled) setErr(config.loadErrorText || 'Could not load the data file.');
    })();
    return () => { cancelled = true; };
  }, [config]);
  return { data, err };
}

function datasetTabStyle(on, color) {
  return {
    padding: '10px 16px', borderRadius: 999,
    fontFamily: 'Manrope, sans-serif', fontSize: 13.5, fontWeight: 500,
    color: on ? SRHQ.bg : SRHQ.ink,
    background: on ? color : 'rgba(var(--line-rgb),0.04)',
    border: `1px solid ${on ? color : SRHQ.line}`,
    cursor: 'pointer', transition: 'all .15s ease',
  };
}

function DatasetTabs({ config, groupsByKey, active, onSelect }) {
  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '8px 32px',
                  display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <button onClick={() => onSelect('all')} style={datasetTabStyle('all' === active, SRHQ.ink)}>
        {config.grouping.allLabel || 'All'}
      </button>
      {config.grouping.values.map((key) => {
        const g = groupsByKey[key];
        if (!g) return null;
        const color = config.grouping.colors[key];
        const short = (config.grouping.shortLabels && config.grouping.shortLabels[key]) || g.label;
        return (
          <button key={key} onClick={() => onSelect(key)}
                  style={datasetTabStyle(active === key, color)}>
            <span style={{ width: 7, height: 7, borderRadius: '50%',
                            background: color, display: 'inline-block', marginRight: 8 }} />
            {short}
            {/* Per-group count, same semantics as the section header. */}
            <span style={{ marginLeft: 8, fontSize: 11, color: SRHQ.inkMute,
                           fontFamily: SRHQ.mono }}>{g.count}</span>
          </button>
        );
      })}
    </div>
  );
}

function DatasetToolbar({ config, query, setQuery, chipValue, setChipValue, statusValue, setStatusValue, count }) {
  const chipValues = (config.chip && config.chip.values) || [];
  const statusValues = (config.statusFilter && config.statusFilter.values) || [];
  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '16px 32px 8px',
                  display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <div style={{ position: 'relative', flex: '1 1 320px', minWidth: 260 }}>
        <input value={query} onChange={e => setQuery(e.target.value)}
               placeholder={config.searchPlaceholder || 'Search…'}
               style={{
                 width: '100%', padding: '12px 16px 12px 40px',
                 background: SRHQ.surface, border: `1px solid ${SRHQ.line}`,
                 borderRadius: 10, color: SRHQ.ink, fontSize: 14,
                 fontFamily: SRHQ.body, outline: 'none',
               }} />
        <span style={{ position: 'absolute', left: 14, top: '50%',
                       transform: 'translateY(-50%)', color: SRHQ.inkMute, fontSize: 14 }}>⌕</span>
      </div>
      {chipValues.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {chipValues.map(o => {
            const on = o === chipValue;
            const color = (config.chip.colors && config.chip.colors[o]) || SRHQ.ink;
            return (
              <button key={o} onClick={() => setChipValue(o)} style={{
                padding: '8px 12px', borderRadius: 8,
                fontSize: 12, fontFamily: SRHQ.mono, letterSpacing: 0.5,
                color: on ? SRHQ.bg : color,
                background: on ? color : 'transparent',
                border: `1px solid ${on ? color : SRHQ.line}`,
                cursor: 'pointer',
              }}>{o}</button>
            );
          })}
        </div>
      )}
      {/* Status pre-filter — SHAPE ONLY (see the config doc above). Renders
          nothing for any dataset that leaves `statusFilter.values` empty. */}
      {statusValues.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {statusValues.map(o => {
            const on = statusValue.has(o);
            const color = (config.statusFilter.colors && config.statusFilter.colors[o]) || SRHQ.ink;
            return (
              <button key={o} onClick={() => setStatusValue(prev => {
                const next = new Set(prev);
                if (next.has(o)) next.delete(o); else next.add(o);
                return next;
              })} style={{
                padding: '8px 12px', borderRadius: 8,
                fontSize: 12, fontFamily: SRHQ.mono, letterSpacing: 0.5,
                color: on ? SRHQ.bg : color,
                background: on ? color : 'transparent',
                border: `1px solid ${on ? color : SRHQ.line}`,
                cursor: 'pointer',
              }}>{o}</button>
            );
          })}
        </div>
      )}
      <div style={{ marginLeft: 'auto', fontFamily: SRHQ.mono, fontSize: 12,
                    color: SRHQ.inkMute }}>{count} results</div>
    </div>
  );
}

function DatasetChip({ color, children, solid = false }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      fontFamily: SRHQ.mono, fontSize: 10.5, letterSpacing: 1.2,
      textTransform: 'uppercase', color: solid ? SRHQ.bg : color,
      padding: '3px 8px', borderRadius: 999,
      background: solid ? color : colorAlpha(color, '15'),
      border: solid ? 'none' : `1px solid ${colorAlpha(color, '55')}`,
    }}>{children}</span>
  );
}

function DatasetField({ label, value, color = SRHQ.ink, mono, multi }) {
  const val = value || '—';
  const parts = multi ? String(val).split(/;\s*/) : null;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontFamily: SRHQ.mono, fontSize: 10, letterSpacing: 2,
                    textTransform: 'uppercase', color: SRHQ.inkMute }}>{label}</div>
      <div style={{ fontFamily: mono ? SRHQ.mono : SRHQ.body, fontSize: 14,
                    color, marginTop: 6, lineHeight: 1.5 }}>
        {parts
          ? parts.map((p, i) => (
              <span key={i} style={{
                display: 'inline-block', padding: '3px 8px', margin: '2px 4px 2px 0',
                background: 'rgba(var(--line-rgb),0.04)', borderRadius: 6,
                border: `1px solid ${SRHQ.line}`, fontSize: 12,
              }}>{p}</span>
            ))
          : val}
      </div>
    </div>
  );
}

function renderCardField(f, item, chipInfo, key) {
  const altVal = f.altKey ? item[f.altKey] : undefined;
  let raw = item[f.key];
  if (!raw && altVal) raw = altVal;
  // `always` fields render unconditionally (matching the pre-refactor Row's
  // Traction/Builder/Year, which had no `k.x &&` guard) — an empty value
  // still prints its label with DatasetField's own '—' fallback. Every other
  // field is skipped outright when it has nothing to show.
  if (!raw && !f.always) return null;
  // Matches the pre-refactor label logic exactly: chosen by the ALT value's
  // own truthiness (`k.yearsBuilt ? 'Years built' : 'Year introduced'`), not
  // by whether raw ended up falling back to it — the two are the same for
  // every real row today (yearIntro/yearsBuilt are mutually exclusive per
  // section), but this keeps the identical rule rather than a look-alike one.
  const label = altVal ? (f.altLabel || f.label) : f.label;
  const value = f.format ? f.format(raw, item) : raw;
  const color = f.colorFromChip && chipInfo ? chipInfo.color : f.color;
  if (f.link) {
    return (
      <DatasetField key={key} label={label} value={
        <a href={raw} target="_blank" rel="noreferrer noopener"
           style={{ color: SRHQ.turq, textDecoration: 'underline' }}>{raw}</a>
      } />
    );
  }
  return <DatasetField key={key} label={label} value={value} mono={f.mono} multi={f.multi} color={color} />;
}

function DatasetColumnHead({ config }) {
  const s = config.card.summary;
  return (
    <div className="row-grid" style={{
      display: 'grid',
      gridTemplateColumns: s.gridTemplate,
      gap: 20, alignItems: 'center',
      padding: '14px 24px',
      fontFamily: SRHQ.mono, fontSize: 10.5, letterSpacing: 2,
      textTransform: 'uppercase', color: SRHQ.inkMute,
      borderBottom: `1px solid ${SRHQ.line}`,
    }}>
      {s.headers.map((h, i) => <span key={i} className={h.className}>{h.text}</span>)}
    </div>
  );
}

function DatasetRow({ config, groupKey, groupsByKey, item }) {
  const [open, setOpen] = React.useState(false);
  const s = config.card.summary;
  const chipInfo = config.chip ? config.chip.classify(item[config.chip.field]) : null;
  const displayName = firstTruthy(item, s.nameFields);
  const year = firstTruthy(item, s.yearFields);
  const runner = firstTruthy(item, s.runnerFields);
  const runnerFirst = runner.split(';')[0].trim();
  const groupColor = config.grouping.colors[groupKey];
  const crossListText = crossListLabel(item, groupKey, groupsByKey);

  const fullNodes = (config.card.full || []).map((f, i) => f.derive === 'crossList'
    ? (crossListText ? <DatasetField key={'x' + i} label={f.label} value={crossListText} /> : null)
    : renderCardField(f, item, chipInfo, 'f' + i));
  const anyFull = fullNodes.some(Boolean);

  return (
    <div id={item.domId} style={{ borderBottom: `1px solid ${SRHQ.line}` }}>
      <button onClick={() => setOpen(o => !o)} className="row-hover row-grid" style={{
        width: '100%', textAlign: 'left', cursor: 'pointer',
        background: 'transparent', border: 'none', color: SRHQ.ink,
        padding: '14px 24px',
        display: 'grid',
        gridTemplateColumns: s.gridTemplate,
        gap: 20, alignItems: 'center',
        transition: 'background .12s ease',
      }}>
        <div className="col-class" style={{
          fontFamily: SRHQ.mono, fontSize: 16, fontWeight: 500,
          color: groupColor, letterSpacing: -0.3,
        }}>{item[s.classField]}</div>

        <div>
          <div style={{ fontFamily: SRHQ.display, fontSize: 16, fontWeight: 600,
                        color: SRHQ.ink, letterSpacing: -0.3 }}>{displayName}</div>
          <div style={{ fontSize: 12, color: SRHQ.inkMute, marginTop: 3,
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item[s.subtitleField]}</div>
        </div>

        {chipInfo && <DatasetChip color={chipInfo.color}>{chipInfo.label}</DatasetChip>}

        <div className="col-year" style={{ fontFamily: SRHQ.mono, fontSize: 12.5, color: SRHQ.inkDim }}>
          {year || '—'}
        </div>
        <div className="col-speed" style={{ fontFamily: SRHQ.mono, fontSize: 12.5, color: SRHQ.ink }}>
          {item[s.speedField] ? s.speedFormat(item[s.speedField]) : (item[s.speedFallbackField] || '—')}
        </div>
        <div className="col-op" style={{ fontSize: 13, color: SRHQ.inkDim,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {runnerFirst}
        </div>
        <div style={{ color: SRHQ.inkMute, fontSize: 14,
                      transition: 'transform .2s ease',
                      transform: open ? 'rotate(90deg)' : 'none' }}>›</div>
      </button>

      {open && (
        <div className="row-expanded" style={{ padding: '4px 24px 24px', background: 'rgba(var(--line-rgb),0.015)' }}>
          <div className="row-expanded-panel" style={{ borderRadius: 12,
                        padding: '20px 24px', background: SRHQ.surface, border: `1px solid ${SRHQ.line}` }}>
            <div className="row-expanded-grid" style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr 1fr', gap: 20 }}>
              {config.card.renderImage ? config.card.renderImage(item, groupColor, displayName) : null}
              <div>
                {(config.card.left || []).map((f, i) => renderCardField(f, item, chipInfo, 'l' + i))}
              </div>
              <div>
                {(config.card.right || []).map((f, i) => renderCardField(f, item, chipInfo, 'r' + i))}
              </div>
            </div>

            {/* Spacing only, no divider rule — matches the Database.jpg
                mockup's visual treatment (2026-08-30): the field grid and
                these full-width extras read as one continuous panel. */}
            {anyFull && (
              <div className="row-expanded-extra" style={{ marginTop: 20 }}>
                {fullNodes}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function makeFilterItem(config, chipValue, statusValue, query) {
  const q = query.trim().toLowerCase();
  const noFilterChip = config.chip ? config.chip.values[0] : null;
  return (item) => {
    if (config.chip && chipValue !== noFilterChip) {
      const info = config.chip.classify(item[config.chip.field]);
      if (!info || info.label !== chipValue) return false;
    }
    if (config.statusFilter && config.statusFilter.field && statusValue && statusValue.size) {
      if (!statusValue.has(item[config.statusFilter.field])) return false;
    }
    if (q) {
      const hay = (config.searchFields || []).map(f => item[f] || '').join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  };
}

function DatasetExplorer({ config, header }) {
  const { data, err } = useDatasetLoader(config);
  const [active, setActive] = React.useState('all');
  const [query, setQuery] = React.useState('');
  const [chipValue, setChipValue] = React.useState(config.chip ? config.chip.values[0] : null);
  const [statusValue, setStatusValue] = React.useState(
    new Set((config.statusFilter && config.statusFilter.default) || []));

  // A deep link (e.g. map.html's Fleet chips, '#fleet-{slug}') arrives before
  // the data file has loaded, so the browser's native on-load fragment
  // scroll fires too early and finds nothing — do it ourselves once the
  // matching row has actually rendered. rAF (not a plain effect) waits for
  // the just-committed DOM paint before scrollIntoView.
  React.useEffect(() => {
    if (!data) return;
    const prefix = config.deepLinkPrefix;
    if (!prefix) return;
    const hash = window.location.hash;
    if (!hash.startsWith('#' + prefix)) return;
    requestAnimationFrame(() => {
      const el = document.getElementById(hash.slice(1));
      if (!el) return;
      // Expand the row (if not already open) before scrolling to it —
      // expanding changes the row's height, so scrolling first would land in
      // the wrong place once the resulting re-render lands (2026-07-21
      // feedback). Reuses DatasetRow's own toggle button/local state rather
      // than adding a controlled-open prop — a real .click() goes through the
      // exact same code path a user click would.
      if (!el.querySelector('.row-expanded')) {
        var toggleBtn = el.querySelector('button');
        if (toggleBtn) toggleBtn.click();
      }
      // Second rAF: waits for the click's state update to actually commit
      // and paint (the row is now taller) before measuring scroll position.
      requestAnimationFrame(() => {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
  }, [data]);

  if (err) {
    return (
      <>
        <TopNav current={config.topNavCurrent} />
        <div style={{ maxWidth: 620, margin: '0 auto', padding: '80px 32px',
                      textAlign: 'center' }}>
          <div style={{ fontFamily: SRHQ.mono, fontSize: 11, letterSpacing: 3,
                        textTransform: 'uppercase', color: SRHQ.coral }}>Data unavailable</div>
          <p style={{ fontSize: 16, color: SRHQ.inkDim, marginTop: 16, lineHeight: 1.6 }}>{err}</p>
          <button onClick={() => location.reload()} style={{
            marginTop: 20, padding: '10px 18px', borderRadius: 10,
            background: SRHQ.turq, color: SRHQ.bg, border: 'none',
            fontFamily: SRHQ.body, fontSize: 14, fontWeight: 600, cursor: 'pointer',
          }}>Retry</button>
        </div>
      </>
    );
  }

  if (!data) {
    return (
      <>
        <TopNav current={config.topNavCurrent} />
        <div style={{ padding: 60, textAlign: 'center', color: SRHQ.inkDim }}>Loading…</div>
      </>
    );
  }

  const groupsByKey = Object.fromEntries(data.groups.map(g => [g.key, g]));
  const filterItem = makeFilterItem(config, chipValue, statusValue, query);

  const orderedGroups = config.grouping.values.map(key => groupsByKey[key]).filter(Boolean);
  const sectionsToRender = orderedGroups
    .filter(g => active === 'all' || g.key === active)
    .map(g => ({
      ...g,
      filtered: data.items.filter(it => it[config.grouping.field] === g.key).filter(filterItem),
    }));

  const dedupe = config.dedupeKey || ((item) => item.domId);
  // GLOBAL total counts each item ONCE however many groups it is listed in —
  // summing the per-group counts would double-count any cross-listed ones.
  const total = new Set(sectionsToRender.flatMap(g => g.filtered.map(dedupe))).size;

  return (
    <>
      <TopNav current={config.topNavCurrent} />
      {header}
      <DatasetTabs config={config} groupsByKey={groupsByKey} active={active} onSelect={setActive} />
      <DatasetToolbar config={config} query={query} setQuery={setQuery}
        chipValue={chipValue} setChipValue={setChipValue}
        statusValue={statusValue} setStatusValue={setStatusValue}
        count={total} />

      <section style={{ maxWidth: 1280, margin: '0 auto', padding: '16px 32px 40px' }}>
        {sectionsToRender.map(g => {
          if (g.filtered.length === 0) return null;
          const color = config.grouping.colors[g.key];
          const isOpen = g.count <= config.collapseThreshold;
          return (
            <details key={g.key} open={isOpen} style={{
              background: SRHQ.surface, border: `1px solid ${SRHQ.line}`,
              borderRadius: 16, marginBottom: 16, overflow: 'hidden',
            }}>
              <summary style={{
                padding: '18px 24px',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                borderBottom: `1px solid ${SRHQ.line}`,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <span style={{ width: 10, height: 10, borderRadius: '50%',
                                  background: color,
                                  boxShadow: `0 0 0 4px ${colorAlpha(color, '22')}` }} />
                  <span style={{ fontFamily: SRHQ.display, fontSize: 20, fontWeight: 600,
                                  letterSpacing: -0.5 }}>{g.label}</span>
                  {/* PER-GROUP count: items appearing in THIS group, so a
                      cross-listed item counts here and in its other groups.
                      The global figure in the toolbar counts it once. */}
                  <span style={{ fontFamily: SRHQ.mono, fontSize: 11, color: SRHQ.inkMute,
                                  letterSpacing: 1 }}>
                    {g.filtered.length} / {g.count}
                  </span>
                </div>
                <span style={{ fontSize: 13, color: SRHQ.inkDim, maxWidth: 540,
                               textAlign: 'right' }}>{g.subtitle}</span>
              </summary>
              <DatasetColumnHead config={config} />
              {g.filtered.map(item => (
                <DatasetRow key={item.domId} config={config} groupKey={g.key} groupsByKey={groupsByKey} item={item} />
              ))}
            </details>
          );
        })}

        {total === 0 && (
          <div style={{ padding: 60, textAlign: 'center', color: SRHQ.inkDim,
                        background: SRHQ.surface, border: `1px solid ${SRHQ.line}`,
                        borderRadius: 16 }}>
            {config.emptyStateText || 'No results match those filters.'}
          </div>
        )}
      </section>
      <Footer />
      <CookieConsent />
    </>
  );
}

Object.assign(window, {
  SRHQ, BrandMark, TopNav, Footer, CookieConsent, colorAlpha, useTheme, logoSrc,
  regionKeyFor,
  DatasetExplorer,
});
