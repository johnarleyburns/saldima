// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One stylesheet for every server-rendered page. It mirrors the iOS design
 * language: indigo accent, rounded cards, colour-coded account types, a
 * translucent app bar and light/dark support. No external fonts or CDNs.
 */
export const designCss = `
:root {
  --accent: #4f46e5;
  --accent-strong: #4338ca;
  --accent-soft: color-mix(in srgb, var(--accent) 12%, transparent);
  --bg: #f6f6fb;
  --panel: #ffffff;
  --text: #17171d;
  --muted: #5d5d6b;
  --border: rgba(23, 23, 29, 0.10);
  --shadow: 0 10px 30px rgba(24, 24, 40, 0.08);
  --radius: 16px;
  color-scheme: light dark;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-synthesis: none;
}
@media (prefers-color-scheme: dark) {
  :root {
    --accent: #7c86ff;
    --accent-strong: #9aa2ff;
    --accent-soft: color-mix(in srgb, var(--accent) 22%, transparent);
    --bg: #0e0f14;
    --panel: #171923;
    --text: #f2f2f7;
    --muted: #a5a5b4;
    --border: rgba(255, 255, 255, 0.12);
    --shadow: 0 12px 34px rgba(0, 0, 0, 0.45);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  background:
    radial-gradient(60rem 40rem at 110% -10%, color-mix(in srgb, var(--accent) 14%, transparent), transparent 60%),
    radial-gradient(50rem 30rem at -10% 0%, color-mix(in srgb, #22d3ee 10%, transparent), transparent 55%),
    var(--bg);
  color: var(--text);
  line-height: 1.55;
}
main { width: min(64rem, 100% - 2.5rem); margin: 0 auto; padding: 2rem 0 5rem; }
main.narrow, main:has(> form) { width: min(28rem, 100% - 2.5rem); }
h1 { font-size: clamp(1.9rem, 4vw, 2.6rem); line-height: 1.15; letter-spacing: -0.02em; margin: 0 0 .4rem; }
h2 { font-size: 1.2rem; margin: 2rem 0 .75rem; letter-spacing: -0.01em; }
p { margin: .4rem 0 1rem; }
a { color: var(--accent-strong); }
.muted { color: var(--muted); font-size: .92rem; }
.brand { display: inline-flex; align-items: center; gap: .55rem; font-weight: 700; letter-spacing: -0.01em; color: var(--text); text-decoration: none; }
.brand::before {
  content: ""; width: 1.5rem; height: 1.5rem; border-radius: .55rem;
  background: linear-gradient(135deg, var(--accent), #22d3ee);
  box-shadow: 0 4px 14px color-mix(in srgb, var(--accent) 40%, transparent);
}
.appbar {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: center; justify-content: space-between; gap: 1rem;
  padding: .8rem 1.2rem; margin: 0 auto 1.6rem; width: min(64rem, 100% - 1.5rem);
  background: color-mix(in srgb, var(--panel) 78%, transparent);
  border: 1px solid var(--border); border-radius: 999px; box-shadow: var(--shadow);
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
}
.nav-toggle-checkbox { position: absolute; opacity: 0; width: 1px; height: 1px; }
.nav-toggle-label {
  cursor: pointer; display: inline-flex; align-items: center; gap: .4rem;
  min-height: 2.5rem; padding: 0 1rem; border-radius: 999px; font-weight: 600; user-select: none;
}
.nav-toggle-label::before { content: "☰"; }
.nav-toggle-checkbox:checked ~ .nav-toggle-label::before { content: "✕"; }
.nav-toggle-checkbox:focus-visible ~ .nav-toggle-label { outline: 3px solid var(--accent-soft); }
.nav-panel {
  display: none; flex-direction: column; gap: .15rem;
  position: absolute; right: 0; top: calc(100% + .6rem); min-width: 12rem;
  background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
  padding: .5rem; box-shadow: var(--shadow); z-index: 20;
}
.nav-toggle-checkbox:checked ~ .nav-panel { display: flex; }
.appbar nav a {
  display: inline-flex; align-items: center; min-height: 2.5rem; padding: 0 .9rem;
  border-radius: 10px; color: var(--text); text-decoration: none; font-weight: 550;
}
.appbar nav a:hover, .appbar nav a[aria-current="page"] { background: var(--accent-soft); color: var(--accent-strong); }
@media (min-width: 56rem) {
  .nav-toggle-label { display: none; }
  .nav-panel {
    display: flex !important; flex-direction: row; flex-wrap: wrap; gap: .35rem;
    position: static; min-width: 0; background: none; border: 0; box-shadow: none; padding: 0;
  }
  .appbar nav a { border-radius: 999px; }
}
.card {
  background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 1.25rem 1.35rem; box-shadow: var(--shadow);
}
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: 1rem; }
.summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: .9rem; margin: 1.25rem 0 1.5rem; }
.stat { border-radius: var(--radius); padding: 1rem 1.1rem; color: white; box-shadow: var(--shadow); }
.stat .label { font-size: .8rem; font-weight: 600; opacity: .85; text-transform: uppercase; letter-spacing: .06em; }
.stat .value { font-size: 1.6rem; font-weight: 650; font-variant-numeric: tabular-nums; }
.stat.accent { background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 55%, #22d3ee)); }
.stat.green { background: linear-gradient(135deg, #0f9d76, #34d399); }
.stat.blue { background: linear-gradient(135deg, #2563eb, #60a5fa); }
.hero { padding: 3.5rem 0 2rem; }
.hero .lede { font-size: 1.1rem; color: var(--muted); max-width: 38rem; }
.cta {
  display: inline-flex; align-items: center; justify-content: center; gap: .5rem;
  min-height: 2.9rem; padding: 0 1.4rem; margin-right: .6rem; margin-top: .6rem;
  border-radius: 999px; background: linear-gradient(135deg, var(--accent), var(--accent-strong));
  color: white; font-weight: 650; text-decoration: none; border: 0;
  box-shadow: 0 8px 24px color-mix(in srgb, var(--accent) 35%, transparent);
}
.cta.secondary { background: transparent; color: var(--text); border: 1px solid var(--border); box-shadow: none; }
label { display: block; margin-top: 1rem; font-weight: 600; font-size: .92rem; }
input, select, textarea {
  width: 100%; min-height: 2.9rem; margin-top: .35rem; padding: .6rem .8rem;
  font: inherit; color: inherit; background: var(--panel);
  border: 1px solid var(--border); border-radius: 12px;
}
input:focus, select:focus, textarea:focus {
  outline: 3px solid var(--accent-soft); border-color: var(--accent);
}
button, .button {
  display: inline-flex; align-items: center; justify-content: center;
  min-height: 2.9rem; padding: 0 1.1rem; margin-top: 1.2rem; width: 100%;
  font: inherit; font-weight: 650; color: white; cursor: pointer;
  background: linear-gradient(135deg, var(--accent), var(--accent-strong));
  border: 0; border-radius: 12px;
  box-shadow: 0 8px 22px color-mix(in srgb, var(--accent) 30%, transparent);
}
button.secondary, .button.secondary { background: transparent; color: var(--text); border: 1px solid var(--border); box-shadow: none; }
button.danger, .danger { background: #b91c1c; box-shadow: none; }
.error { padding: .8rem 1rem; border-radius: 12px; background: #7f1d1d; color: white; }
code { display: block; overflow-wrap: anywhere; padding: .8rem; background: var(--accent-soft); border-radius: 10px; }
.qr { max-width: 15rem; margin: 1rem auto; padding: .75rem; background: white; border-radius: 16px; }
.qr svg { display: block; width: 100%; height: auto; }
.appfoot {
  margin: 3.5rem auto 0; width: min(64rem, 100% - 2.5rem);
  padding-top: 1rem; border-top: 1px solid var(--border);
  font-size: .9rem; color: var(--muted); display: flex; gap: 1rem; flex-wrap: wrap;
}
.appfoot a { color: inherit; }
.accounts { list-style: none; margin: 0; padding: 0; }
.accounts li { padding: .1rem 0; }
.accounts details { margin: 0; }
.accounts summary {
  list-style: none; display: flex; align-items: center; gap: .5rem;
  min-height: 2.75rem; cursor: pointer; border-bottom: 1px solid var(--border);
}
.accounts summary::-webkit-details-marker { display: none; }
.accounts summary::before {
  content: "▸"; color: var(--muted); width: 1rem; transition: transform .15s ease;
}
.accounts details[open] > summary::before { content: "▾"; }
.accounts summary a { color: var(--text); text-decoration: none; }
.accounts summary a:hover strong { color: var(--accent-strong); }
.accounts ul { list-style: none; margin: 0 0 0 1.5rem; padding: 0; }
.accounts li > a, .accounts li > span.row {
  display: flex; align-items: center; gap: .5rem; min-height: 2.75rem;
  border-bottom: 1px solid var(--border);
}
.accounts a { color: var(--text); text-decoration: none; }
.amount { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 600; }
.journal { list-style: none; margin: .5rem 0 0; padding: 0; }
.journal li { display: flex; justify-content: space-between; gap: 1rem; padding: .3rem 0; border-bottom: 1px solid var(--border); }
.chip {
  display: inline-flex; align-items: center; padding: .12rem .5rem;
  border-radius: 999px; font-size: .74rem; font-weight: 650; letter-spacing: .02em;
  background: var(--accent-soft); color: var(--accent-strong);
}
.type-asset, .type-bank, .type-cash, .type-receivable { background: rgba(16, 185, 129, .16); color: #0f766e; }
.type-liability, .type-credit, .type-payable { background: rgba(239, 68, 68, .14); color: #b91c1c; }
.type-income { background: rgba(13, 148, 136, .16); color: #0f766e; }
.type-expense { background: rgba(139, 92, 246, .16); color: #6d28d9; }
.type-equity { background: rgba(79, 70, 229, .16); color: #4338ca; }
@media (prefers-color-scheme: dark) {
  .type-asset, .type-bank, .type-cash, .type-receivable,
  .type-income { color: #6ee7b7; }
  .type-liability, .type-credit, .type-payable { color: #fca5a5; }
  .type-expense { color: #c4b5fd; }
  .type-equity { color: #a5b4fc; }
}
`;
