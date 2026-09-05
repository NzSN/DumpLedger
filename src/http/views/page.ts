function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export { escapeHtml };

export interface PageOptions {
  readonly chrome?: "operator" | "public";
  readonly csrfToken?: string;
  readonly wide?: boolean;
  readonly bodyClass?: string;
}

const brandMark = `<svg viewBox="0 0 36 36" aria-hidden="true">
  <path d="M18 3 31 8v9c0 8.4-5.2 13.4-13 16C10.2 30.4 5 25.4 5 17V8l13-5Z" fill="currentColor" opacity=".18"/>
  <path d="M18 6.6 27.6 10v7c0 6.2-3.6 10.1-9.6 12.6C12 27.1 8.4 23.2 8.4 17v-7L18 6.6Z" fill="none" stroke="currentColor" stroke-width="1.7"/>
  <path d="M13 15.2h10M13 19h10M13 22.8h6.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
</svg>`;

export function page(title: string, body: string, options: PageOptions = {}): string {
  const chrome = options.chrome ?? "operator";
  const operatorNav = chrome === "operator"
    ? `<nav class="primary-nav" aria-label="Primary navigation">
        <a href="/">Cases</a>
        <a href="/operations">Operations</a>
        ${options.csrfToken === undefined ? "" : `<form method="post" action="/logout" class="nav-form">
          <input type="hidden" name="csrf" value="${escapeHtml(options.csrfToken)}">
          <button type="submit" class="nav-signout">Sign out</button>
        </form>`}
      </nav>`
    : `<span class="trust-chip"><span class="trust-dot"></span>Private intake</span>`;
  const bodyClass = [chrome === "public" ? "public-page" : "operator-page", options.bodyClass]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .map(escapeHtml)
    .join(" ");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta name="theme-color" content="#07111f">
  <title>${escapeHtml(title)} · DumpLedger</title>
  <link rel="stylesheet" href="/assets/app.css">
  <script src="/assets/app.js" defer></script>
</head>
<body class="${bodyClass}">
  <a class="skip-link" href="#content">Skip to content</a>
  <div class="ambient ambient-one"></div>
  <div class="ambient ambient-two"></div>
  <header class="topbar">
    <a class="brand" href="${chrome === "operator" ? "/" : "/login"}" aria-label="DumpLedger home">
      <span class="brand-mark">${brandMark}</span>
      <span class="brand-copy"><strong>DumpLedger</strong><small>Crash evidence vault</small></span>
    </a>
    ${operatorNav}
  </header>
  <main id="content" class="page-frame${options.wide === true ? " page-frame-wide" : ""}">${body}</main>
  <footer class="site-footer"><span>DumpLedger</span><span>Private by design · original bytes stay immutable</span></footer>
</body>
</html>`;
}
