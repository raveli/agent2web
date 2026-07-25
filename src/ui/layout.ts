import { esc } from '../util/html.js';

const BASE_STYLE = `
:root { color-scheme: light dark; --fg:#141414; --muted:#666; --bg:#fafafa; --card:#fff; --line:#e4e4e4;
  --accent:#2f6feb; --danger:#b42318; --code:#f3f3f3; }
@media (prefers-color-scheme: dark) {
  :root { --fg:#e9e9e9; --muted:#9b9b9b; --bg:#121212; --card:#1b1b1b; --line:#2e2e2e;
    --accent:#7aa2ff; --danger:#ff9b93; --code:#242424; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg);
  font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
a { color:var(--accent); }
h1 { font-size:1.2rem; margin:0 0 4px; }
h2 { font-size:1rem; margin:28px 0 10px; }
p { color:var(--muted); margin:0 0 18px; font-size:.925rem; }
code, .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.85em;
  background:var(--code); padding:1px 5px; border-radius:4px; }
label { display:block; font-size:.85rem; font-weight:600; margin-bottom:6px; }
input[type=text], input[type=password] { width:100%; padding:10px 12px; font-size:1rem; border:1px solid var(--line);
  border-radius:8px; background:var(--bg); color:var(--fg); margin-bottom:16px; }
input:focus { outline:2px solid var(--accent); outline-offset:1px; }
button { padding:9px 14px; font-size:.95rem; font-weight:600; border:0; border-radius:8px;
  background:var(--accent); color:#fff; cursor:pointer; }
button.secondary { background:transparent; color:var(--fg); border:1px solid var(--line); }
button.danger { background:transparent; color:var(--danger); border:1px solid var(--line); }
.err { background:#fdecec; color:#8c1c1c; border:1px solid #f3c0c0; border-radius:8px; padding:10px 12px;
  font-size:.9rem; margin-bottom:16px; }
.ok { background:#eaf6ec; color:#1c6b2c; border:1px solid #bfe2c6; border-radius:8px; padding:10px 12px;
  font-size:.9rem; margin-bottom:16px; }
@media (prefers-color-scheme: dark) {
  .err { background:#3a1c1c; color:#ffb4b4; border-color:#5e2a2a; }
  .ok { background:#16301c; color:#a8e0b5; border-color:#2c5636; }
}
`;

const CARD_STYLE = `
body { min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:28px; width:100%; max-width:28rem; }
.card button[type=submit] { width:100%; }
.row { display:flex; gap:10px; }
.row button { flex:1; }
dl { margin:0 0 20px; font-size:.9rem; }
dt { color:var(--muted); font-size:.8rem; text-transform:uppercase; letter-spacing:.03em; margin-top:12px; }
dd { margin:2px 0 0; word-break:break-all; }
`;

const PAGE_STYLE = `
.wrap { max-width:64rem; margin:0 auto; padding:28px 20px 60px; }
header.top { display:flex; align-items:baseline; gap:16px; border-bottom:1px solid var(--line);
  padding-bottom:14px; margin-bottom:22px; flex-wrap:wrap; }
header.top .brand { font-weight:700; }
header.top nav { margin-left:auto; display:flex; gap:14px; font-size:.9rem; }
table { width:100%; border-collapse:collapse; font-size:.9rem; }
th, td { text-align:left; padding:9px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-size:.75rem; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
td form { display:inline; }
.actions { display:flex; flex-wrap:wrap; gap:6px; }
.actions button { padding:5px 9px; font-size:.8rem; font-weight:500; }
.card-block { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px 20px; margin-bottom:18px; }
.card-block form { display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end; }
.card-block label { margin-bottom:4px; }
.card-block input { margin-bottom:0; width:auto; min-width:12rem; flex:1; }
.scroll { overflow-x:auto; }
.pill { display:inline-block; font-size:.72rem; padding:2px 7px; border-radius:20px; border:1px solid var(--line); color:var(--muted); }
`;

function document_(title: string, style: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title><style>${BASE_STYLE}${style}</style></head>
<body>${body}</body></html>`;
}

/** Centred single-card layout used for every login, consent and error page. */
export function card(title: string, body: string): string {
  return document_(title, CARD_STYLE, `<main class="card">${body}</main>`);
}

/** Full-width layout with a nav bar, used by the admin pages. */
export function page(title: string, body: string, nav: { href: string; label: string }[]): string {
  const links = nav.map(item => `<a href="${esc(item.href)}">${esc(item.label)}</a>`).join('');
  return document_(
    title,
    PAGE_STYLE,
    `<div class="wrap">
<header class="top"><span class="brand">agent2web</span><nav>${links}</nav></header>
<main>${body}</main></div>`,
  );
}
