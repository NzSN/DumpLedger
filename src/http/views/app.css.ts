export const appCss = `
:root {
  color-scheme: dark;
  font: 16px/1.55 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --bg: #07111f;
  --bg-deep: #040b14;
  --surface: rgba(15, 29, 47, .86);
  --surface-solid: #0f1d2f;
  --surface-raised: #14253a;
  --surface-soft: rgba(23, 42, 65, .64);
  --line: rgba(144, 173, 207, .16);
  --line-strong: rgba(144, 173, 207, .3);
  --text: #f4f8fd;
  --text-soft: #c1d0df;
  --muted: #849ab2;
  --accent: #67e8c1;
  --accent-strong: #25c99b;
  --blue: #73a8ff;
  --amber: #f7bd73;
  --red: #ff7d8f;
  --green: #64dfb4;
  --shadow: 0 24px 70px rgba(0, 8, 20, .34);
  --radius: 18px;
}

* { box-sizing: border-box; }
body, header, main, footer, section, article, div { min-width: 0; }
html { min-height: 100%; background: var(--bg-deep); }
body {
  min-height: 100vh;
  margin: 0;
  color: var(--text);
  background:
    radial-gradient(circle at 12% -8%, rgba(71, 132, 255, .15), transparent 31rem),
    radial-gradient(circle at 92% 18%, rgba(45, 211, 162, .09), transparent 28rem),
    linear-gradient(160deg, var(--bg-deep), var(--bg) 44%, #0a1626);
  overflow-x: hidden;
}

a { color: inherit; }
button, input { font: inherit; }
button, a { -webkit-tap-highlight-color: transparent; }
button:focus-visible, a:focus-visible, input:focus-visible {
  outline: 3px solid rgba(103, 232, 193, .34);
  outline-offset: 3px;
}

.ambient { position: fixed; width: 28rem; height: 28rem; border-radius: 50%; filter: blur(90px); pointer-events: none; opacity: .14; z-index: -1; }
.ambient-one { left: -14rem; top: 18rem; background: #367eff; }
.ambient-two { right: -14rem; bottom: -9rem; background: #23cfa0; }
.skip-link { position: fixed; left: 1rem; top: -5rem; z-index: 20; padding: .65rem 1rem; color: #06111f; background: var(--accent); border-radius: 10px; font-weight: 750; text-decoration: none; }
.skip-link:focus { top: 1rem; }

.topbar {
  width: min(1280px, calc(100% - 40px));
  min-height: 78px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
  border-bottom: 1px solid var(--line);
}
.brand { display: inline-flex; align-items: center; gap: .75rem; text-decoration: none; }
.brand-mark { display: grid; place-items: center; width: 42px; height: 42px; color: var(--accent); border: 1px solid rgba(103, 232, 193, .24); border-radius: 13px; background: rgba(103, 232, 193, .08); box-shadow: inset 0 1px rgba(255,255,255,.07); }
.brand-mark svg { width: 31px; height: 31px; }
.brand-copy { display: grid; line-height: 1.15; }
.brand-copy strong { letter-spacing: -.02em; font-size: 1.02rem; }
.brand-copy small { color: var(--muted); font-size: .7rem; letter-spacing: .08em; text-transform: uppercase; margin-top: .23rem; }
.primary-nav { display: flex; align-items: center; gap: .25rem; }
.primary-nav > a, .nav-signout { color: var(--text-soft); padding: .55rem .8rem; border-radius: 10px; border: 0; background: transparent; text-decoration: none; cursor: pointer; font-size: .86rem; font-weight: 650; }
.primary-nav > a:hover, .nav-signout:hover { color: var(--text); background: rgba(255,255,255,.055); }
.nav-form { display: inline; margin: 0; }
.trust-chip { display: inline-flex; align-items: center; gap: .5rem; padding: .45rem .72rem; color: var(--text-soft); background: rgba(255,255,255,.035); border: 1px solid var(--line); border-radius: 999px; font-size: .77rem; }
.trust-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); box-shadow: 0 0 13px rgba(100,223,180,.75); }

.page-frame { width: min(1120px, calc(100% - 40px)); margin: 0 auto; padding: 4.4rem 0 6rem; }
.page-frame-wide { width: min(1280px, calc(100% - 40px)); }
.site-footer { width: min(1280px, calc(100% - 40px)); margin: 0 auto; padding: 1.2rem 0 2.4rem; display: flex; justify-content: space-between; gap: 1rem; color: #657b92; border-top: 1px solid var(--line); font-size: .75rem; }

.eyebrow { margin: 0 0 .65rem; color: var(--accent); font-size: .72rem; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; }
.page-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 1.5rem; margin-bottom: 2rem; }
.page-heading h1, .hero-title { margin: 0; font-size: clamp(2rem, 4vw, 3.3rem); line-height: 1.06; letter-spacing: -.045em; }
.page-heading p, .hero-copy { max-width: 43rem; margin: .75rem 0 0; color: var(--muted); font-size: .98rem; }
.heading-actions { display: flex; gap: .65rem; flex-wrap: wrap; }
.breadcrumb { display: flex; gap: .5rem; margin-bottom: 1.2rem; color: var(--muted); font-size: .8rem; }
.breadcrumb a { color: var(--text-soft); text-decoration: none; }
.breadcrumb a:hover { color: var(--accent); }

.metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .8rem; margin: 0 0 2rem; }
.metric { min-height: 106px; padding: 1rem 1.1rem; border: 1px solid var(--line); border-radius: 15px; background: rgba(14, 27, 44, .72); box-shadow: inset 0 1px rgba(255,255,255,.035); }
.metric-label { display: block; color: var(--muted); font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .09em; }
.metric-value { display: block; margin-top: .3rem; font-size: 1.8rem; font-weight: 760; letter-spacing: -.04em; }
.metric-note { display: block; color: #71879d; font-size: .72rem; }

.layout-grid { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(290px, .8fr); gap: 1rem; align-items: start; }
.stack { display: grid; gap: 1rem; }
.panel { border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); box-shadow: var(--shadow); backdrop-filter: blur(18px); overflow: hidden; }
.panel-header { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: 1.2rem 1.3rem; border-bottom: 1px solid var(--line); }
.panel-header h2 { margin: 0; font-size: 1rem; letter-spacing: -.01em; }
.panel-header p { margin: .15rem 0 0; color: var(--muted); font-size: .78rem; }
.panel-body { padding: 1.25rem 1.3rem; }
.panel-body-flush { padding: .45rem .3rem; }
.panel-accent { background: linear-gradient(145deg, rgba(24,51,70,.92), rgba(13,31,47,.9)); }
.panel-count { display: grid; place-items: center; min-width: 30px; height: 30px; padding: 0 .5rem; color: var(--text-soft); background: rgba(255,255,255,.05); border: 1px solid var(--line); border-radius: 9px; font-size: .75rem; font-weight: 750; }

.case-list, .customer-list, .record-list, .timeline { list-style: none; margin: 0; padding: 0; }
.case-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 1rem; align-items: center; padding: 1rem 1.3rem; border-bottom: 1px solid var(--line); text-decoration: none; transition: background .16s ease, transform .16s ease; }
.case-row:last-child { border-bottom: 0; }
.case-row:hover { background: rgba(115,168,255,.055); }
.case-title { display: block; font-weight: 700; letter-spacing: -.012em; }
.case-meta { display: flex; flex-wrap: wrap; gap: .55rem; margin-top: .3rem; color: var(--muted); font-size: .75rem; }
.customer-card { padding: 1.1rem 1.25rem; border-bottom: 1px solid var(--line); }
.customer-card:last-child { border-bottom: 0; }
.customer-name { font-weight: 720; }
.mono, code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: .78em; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.subtle-id { color: #71879e; }
.inline-create { margin: .8rem 0 0; }
.inline-field { display: flex; gap: .5rem; }
.inline-field input { min-width: 0; }

.status { display: inline-flex; align-items: center; gap: .38rem; white-space: nowrap; padding: .28rem .58rem; border: 1px solid transparent; border-radius: 999px; font-size: .68rem; font-weight: 780; letter-spacing: .035em; text-transform: uppercase; }
.status::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 10px currentColor; }
.status-good { color: var(--green); background: rgba(100,223,180,.08); border-color: rgba(100,223,180,.18); }
.status-info { color: var(--blue); background: rgba(115,168,255,.08); border-color: rgba(115,168,255,.18); }
.status-warn { color: var(--amber); background: rgba(247,189,115,.08); border-color: rgba(247,189,115,.18); }
.status-bad { color: var(--red); background: rgba(255,125,143,.08); border-color: rgba(255,125,143,.18); }
.status-muted { color: #9aacc0; background: rgba(154,172,192,.07); border-color: rgba(154,172,192,.15); }

.button { display: inline-flex; align-items: center; justify-content: center; min-height: 42px; padding: .62rem .95rem; color: #06131b; background: linear-gradient(135deg, #78f0cc, #4dd9b1); border: 0; border-radius: 11px; box-shadow: 0 9px 26px rgba(37,201,155,.18); font-weight: 780; text-decoration: none; cursor: pointer; transition: transform .15s ease, filter .15s ease; }
.button:hover { transform: translateY(-1px); filter: brightness(1.04); }
.button:disabled { opacity: .45; cursor: not-allowed; transform: none; }
.button-secondary { color: var(--text); background: rgba(255,255,255,.055); border: 1px solid var(--line-strong); box-shadow: none; }
.button-danger { color: #ffdbe0; background: rgba(255,125,143,.1); border: 1px solid rgba(255,125,143,.25); box-shadow: none; }
.button-small { min-height: 34px; padding: .42rem .7rem; font-size: .75rem; }
.is-disabled { opacity: .5; pointer-events: none; }

.form-stack { display: grid; gap: .95rem; margin: 0; }
.field { display: grid; gap: .38rem; }
.field-label { color: var(--text-soft); font-size: .77rem; font-weight: 680; }
.field-hint { color: var(--muted); font-size: .7rem; }
input[type="text"], input[type="password"], input[type="number"], input:not([type]) {
  width: 100%; min-height: 44px; padding: .67rem .8rem; color: var(--text); background: rgba(5,14,25,.63); border: 1px solid var(--line-strong); border-radius: 10px; box-shadow: inset 0 1px 3px rgba(0,0,0,.18);
}
input::placeholder { color: #536a82; }
.inline-suffix { display: grid; grid-template-columns: 1fr auto; align-items: center; overflow: hidden; background: rgba(5,14,25,.63); border: 1px solid var(--line-strong); border-radius: 10px; }
.inline-suffix input { border: 0; background: transparent; box-shadow: none; }
.inline-suffix > span { padding: 0 .8rem; color: var(--muted); font-size: .75rem; }
.auth-form { margin-top: 1.5rem; }
.auth-footnote { display: flex; align-items: center; gap: .5rem; margin-top: 1.3rem; color: var(--muted); font-size: .7rem; }

.empty-state { padding: 2.3rem 1.3rem; text-align: center; color: var(--muted); }
.empty-icon { width: 48px; height: 48px; margin: 0 auto .8rem; display: grid; place-items: center; color: var(--accent); background: rgba(103,232,193,.07); border: 1px solid rgba(103,232,193,.16); border-radius: 15px; font-size: 1.25rem; }
.empty-state strong { display: block; color: var(--text-soft); margin-bottom: .2rem; }

.record-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: .9rem 1.2rem; border-bottom: 1px solid var(--line); }
.record-row:last-child { border-bottom: 0; }
.record-main { min-width: 0; }
.record-title { color: var(--text); font-weight: 650; text-decoration: none; }
.record-title:hover { color: var(--accent); }
.record-meta { display: flex; flex-wrap: wrap; gap: .55rem; margin-top: .3rem; color: var(--muted); font-size: .72rem; }
.record-actions { display: flex; align-items: center; justify-content: flex-end; gap: .55rem; }
.compact-form { margin: 0; }

.timeline { padding: .25rem 0; }
.timeline-item { position: relative; padding: .7rem 1rem .7rem 2rem; }
.timeline-item::before { content: ""; position: absolute; left: .73rem; top: 1.08rem; width: 7px; height: 7px; border-radius: 50%; background: var(--blue); box-shadow: 0 0 0 4px rgba(115,168,255,.1); }
.timeline-item:not(:last-child)::after { content: ""; position: absolute; left: .93rem; top: 1.5rem; bottom: -.25rem; width: 1px; background: var(--line); }
.timeline-title { display: block; color: var(--text-soft); font-size: .8rem; font-weight: 650; }
.timeline-time { color: var(--muted); font-size: .68rem; }

.detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
.detail { padding: 1rem; background: var(--surface-solid); }
.detail dt { color: var(--muted); font-size: .68rem; text-transform: uppercase; letter-spacing: .08em; }
.detail dd { margin: .28rem 0 0; color: var(--text-soft); font-weight: 650; }
.detail-title { font-size: clamp(1.1rem, 2.6vw, 1.75rem) !important; letter-spacing: -.035em; }
.side-copy { margin: 0; color: var(--muted); font-size: .78rem; }

.notice { display: flex; min-width: 0; gap: .8rem; padding: 1rem; border: 1px solid rgba(247,189,115,.2); border-radius: 13px; color: #ead7bd; background: rgba(247,189,115,.07); font-size: .78rem; overflow-wrap: anywhere; }
.notice-icon { flex: 0 0 auto; width: 28px; height: 28px; display: grid; place-items: center; border-radius: 9px; background: rgba(247,189,115,.1); color: var(--amber); }

.auth-shell, .upload-shell, .success-shell { width: min(600px, 100%); margin: 2rem auto 0; }
.auth-card, .upload-card, .success-card { padding: clamp(1.4rem, 4vw, 2.4rem); border: 1px solid var(--line); border-radius: 24px; background: rgba(13,27,44,.9); box-shadow: var(--shadow); backdrop-filter: blur(20px); }
.auth-symbol, .success-symbol { width: 58px; height: 58px; display: grid; place-items: center; margin-bottom: 1.35rem; color: var(--accent); background: rgba(103,232,193,.08); border: 1px solid rgba(103,232,193,.18); border-radius: 18px; font-size: 1.4rem; }
.auth-card h1, .upload-card h1, .success-card h1 { margin: 0; font-size: clamp(1.7rem, 5vw, 2.35rem); letter-spacing: -.035em; line-height: 1.1; }
.auth-card > p, .upload-card > p, .success-card > p { color: var(--muted); }

.drop-zone { display: grid; place-items: center; min-height: 218px; margin: 1.35rem 0 1rem; padding: 1.4rem; text-align: center; border: 1.5px dashed rgba(115,168,255,.35); border-radius: 17px; background: rgba(115,168,255,.045); cursor: pointer; transition: border-color .18s ease, background .18s ease, transform .18s ease; }
.drop-zone:hover, .drop-zone.is-dragging { border-color: var(--accent); background: rgba(103,232,193,.07); transform: translateY(-1px); }
.drop-zone.has-file { border-style: solid; border-color: rgba(103,232,193,.4); }
.drop-zone.is-complete { pointer-events: none; opacity: .72; }
.drop-zone input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.drop-icon { width: 54px; height: 54px; display: grid; place-items: center; margin-bottom: .85rem; color: var(--blue); background: rgba(115,168,255,.09); border: 1px solid rgba(115,168,255,.18); border-radius: 16px; font-size: 1.45rem; }
.drop-title { max-width: 100%; font-weight: 720; overflow-wrap: anywhere; }
.drop-copy { max-width: 100%; margin-top: .25rem; color: var(--muted); font-size: .76rem; overflow-wrap: anywhere; }
.selected-file { display: flex; min-width: 0; max-width: 100%; justify-content: center; gap: .5rem; margin-top: .8rem; color: var(--text-soft); font-size: .78rem; overflow-wrap: anywhere; }
.upload-actions { display: flex; align-items: center; gap: 1rem; }
.upload-status { color: var(--muted); font-size: .78rem; }
.upload-status[data-tone="success"] { color: var(--green); }
.upload-status[data-tone="warning"] { color: var(--amber); }
.upload-status[data-tone="error"] { color: var(--red); }
.upload-status[data-tone="active"] { color: var(--blue); }
.progress-track { height: 7px; margin: 1rem 0; overflow: hidden; border-radius: 999px; background: rgba(255,255,255,.07); }
.progress-bar { width: 0; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--blue), var(--accent)); box-shadow: 0 0 20px rgba(103,232,193,.35); transition: width .18s ease; }

.copy-row { display: flex; gap: .6rem; margin: 1.2rem 0; }
.copy-row input { flex: 1; min-width: 0; }
.success-actions { display: flex; margin-top: 1.4rem; }
.privacy-list { display: grid; gap: .6rem; margin: 1.4rem 0 0; padding: 0; list-style: none; color: var(--muted); font-size: .75rem; }
.privacy-list li { display: flex; gap: .55rem; }
.privacy-list li::before { content: "✓"; color: var(--green); font-weight: 800; }
.is-copied { color: #06131b !important; background: var(--accent) !important; }
.metric-grid-three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.metric-word { font-size: 1.25rem; text-transform: capitalize; }
.health-ok { display: flex; gap: .85rem; align-items: flex-start; }
.health-ok > span { width: 32px; height: 32px; flex: 0 0 auto; display: grid; place-items: center; color: #06131b; background: var(--green); border-radius: 10px; font-weight: 900; }
.health-ok strong { color: var(--text); }
.health-ok p { margin: .15rem 0 0; color: var(--muted); font-size: .75rem; }

@media (max-width: 860px) {
  .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .metric-grid-three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .layout-grid { grid-template-columns: 1fr; }
  .page-frame { padding-top: 3rem; }
}

@media (max-width: 600px) {
  .topbar { width: min(100% - 24px, 1280px); min-height: 68px; }
  .page-frame, .page-frame-wide { width: min(100% - 24px, 1280px); padding: 2.4rem 0 4rem; }
  .brand-copy small { display: none; }
  .public-page .trust-chip { display: none; }
  .primary-nav > a { display: none; }
  .page-heading { align-items: flex-start; flex-direction: column; }
  .metric-grid { grid-template-columns: 1fr 1fr; gap: .55rem; }
  .metric { min-height: 90px; padding: .8rem; }
  .metric-value { font-size: 1.45rem; }
  .detail-grid { grid-template-columns: 1fr; }
  .record-row { align-items: flex-start; flex-direction: column; }
  .record-actions { justify-content: flex-start; }
  .copy-row, .upload-actions, .inline-field { align-items: stretch; flex-direction: column; }
  .metric-grid-three { grid-template-columns: 1fr; }
  .auth-card, .upload-card, .success-card { padding: 1.2rem; border-radius: 18px; }
  .drop-zone { min-height: 190px; padding: 1.1rem .85rem; }
  .notice { padding: .85rem; }
  .site-footer { width: calc(100% - 24px); flex-direction: column; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; }
}
`;
