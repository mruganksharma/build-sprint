// Builds the observability dashboard: downloads every scored output from the DEV deployment and
// writes one HTML file on this computer (dashboard/evals.html, never committed: it holds real
// users' resumes and chats). Phone numbers show only their last 4 digits. No Claude calls.
// Run: npm run dashboard        (add --prod to read the production deployment)
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

// ---------- the page ----------
const TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Job Finder Evals</title>
<style>
:root {
  --bg: #f7f7f5; --card: #ffffff; --text: #1d1d1b; --muted: #6b6b66; --line: #e4e4df;
  --best: #1f8a4c; --between: #b7791f; --worst: #c53030; --pending: #8a8a85; --accent: #2b59c3;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #161615; --card: #20201e; --text: #ececea; --muted: #a3a39e; --line: #33332f;
    --best: #48bb78; --between: #ecc94b; --worst: #fc8181; --pending: #a0a09b; --accent: #7f9cf5;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { max-width: 1200px; margin: 0 auto; padding: 20px 16px 60px; }
h1 { font-size: 20px; margin: 0 0 2px; }
.sub { color: var(--muted); margin-bottom: 18px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; margin-bottom: 18px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px; cursor: pointer; }
.card.active { outline: 2px solid var(--accent); }
.card h2 { font-size: 14px; margin: 0 0 2px; }
.card .how { color: var(--muted); font-size: 12px; margin-bottom: 10px; }
.bar { display: flex; height: 10px; border-radius: 5px; overflow: hidden; background: var(--line); margin-bottom: 8px; }
.bar span { display: block; height: 100%; }
.legend { display: flex; gap: 10px; flex-wrap: wrap; font-size: 12px; color: var(--muted); }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; }
.filters { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; align-items: center; }
.filters select, .filters input { background: var(--card); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; font: inherit; }
.filters input[type=search] { flex: 1; min-width: 180px; }
.count { color: var(--muted); font-size: 12px; }
.table { background: var(--card); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.row { display: grid; grid-template-columns: 130px 90px 120px 90px 1fr; gap: 10px; padding: 9px 12px; border-top: 1px solid var(--line); cursor: pointer; align-items: center; }
.row:first-child { border-top: 0; }
.row.head { cursor: default; font-weight: 600; color: var(--muted); font-size: 12px; background: var(--bg); }
.row:not(.head):hover { background: var(--bg); }
.badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; font-weight: 600; color: #fff; }
.b-best { background: var(--best); } .b-between { background: var(--between); } .b-worst { background: var(--worst); } .b-pending { background: var(--pending); }
.why { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail { padding: 10px 12px 14px; border-top: 1px dashed var(--line); background: var(--bg); }
.checks { margin: 0 0 10px; padding: 0; list-style: none; }
.checks li { margin: 3px 0; }
.ok { color: var(--best); font-weight: 700; } .no { color: var(--worst); font-weight: 700; }
.io { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.io h3 { font-size: 12px; color: var(--muted); margin: 0 0 4px; }
pre { margin: 0; background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 8px; max-height: 320px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-size: 12px; }
.link { color: var(--accent); cursor: pointer; text-decoration: underline; }
.empty { padding: 30px; text-align: center; color: var(--muted); }
@media (max-width: 720px) {
  .row { grid-template-columns: 1fr 1fr; }
  .row .why { grid-column: 1 / -1; white-space: normal; }
  .row.head { display: none; }
  .io { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<main>
  <h1>Job Finder Evals</h1>
  <div class="sub">Every output of the agent, scored against the rubric. Built __BUILT__ from the dev deployment. Job Fit comes only from users' yes/no replies.</div>
  <div class="cards" id="cards"></div>
  <div class="filters">
    <select id="f-lever"><option value="">All rows</option></select>
    <select id="f-score"><option value="">All scores</option><option>best</option><option>between</option><option>worst</option><option>pending</option></select>
    <select id="f-user"><option value="">All users</option></select>
    <label class="count">From <input type="date" id="f-from"></label>
    <label class="count">To <input type="date" id="f-to"></label>
    <input type="search" id="f-text" placeholder="Search notes, inputs, outputs…">
    <span class="count" id="count"></span>
  </div>
  <div class="table" id="table"></div>
</main>
<script id="data" type="application/json">__DATA__</script>
<script>
const DATA = JSON.parse(document.getElementById("data").textContent);
const LEVERS = {
  document_read: { name: "Document Read", how: "Separate Claude check: role, industry, location, whole document" },
  preference: { name: "Preference", how: "Rules: search used their role, industry, location, job sites" },
  jobs_found: { name: "Jobs Found", how: "Rules: 5+ new jobs matching role, industry, location" },
  job_fit: { name: "Job Fit", how: "Only users' yes/no replies to the jobs sent" },
};
const SCORES = ["best", "between", "worst", "pending"];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const when = (ms) => new Date(ms).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const day = (ms) => new Date(ms + 5.5 * 3600000).toISOString().slice(0, 10);
const pretty = (s) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } };

const $ = (id) => document.getElementById(id);
for (const [key, l] of Object.entries(LEVERS)) $("f-lever").insertAdjacentHTML("beforeend", '<option value="' + key + '">' + esc(l.name) + "</option>");
for (const u of [...new Set(DATA.map((d) => d.user))].sort()) $("f-user").insertAdjacentHTML("beforeend", '<option>' + esc(u) + "</option>");

let open = null;
let searchFilter = "";
function filtered() {
  const lever = $("f-lever").value, score = $("f-score").value, user = $("f-user").value;
  const from = $("f-from").value, to = $("f-to").value, text = $("f-text").value.toLowerCase();
  return DATA.filter((d) =>
    (!lever || d.lever === lever) && (!score || d.score === score) && (!user || d.user === user) &&
    (!from || day(d.at) >= from) && (!to || day(d.at) <= to) && (!searchFilter || d.search === searchFilter) &&
    (!text || (d.input + d.output + JSON.stringify(d.checks)).toLowerCase().includes(text)));
}

function cards(rows) {
  $("cards").innerHTML = Object.entries(LEVERS).map(([key, l]) => {
    const mine = rows.filter((d) => d.lever === key);
    const n = mine.length || 1;
    const by = Object.fromEntries(SCORES.map((s) => [s, mine.filter((d) => d.score === s).length]));
    return '<div class="card' + ($("f-lever").value === key ? " active" : "") + '" data-lever="' + key + '">' +
      "<h2>" + esc(l.name) + " · " + mine.length + "</h2><div class=how>" + esc(l.how) + "</div>" +
      '<div class="bar">' + SCORES.map((s) => '<span style="width:' + (100 * by[s]) / n + "%;background:var(--" + s + ')"></span>').join("") + "</div>" +
      '<div class="legend">' + SCORES.map((s) => '<span><i class="dot" style="background:var(--' + s + ')"></i>' + s + " " + by[s] + "</span>").join("") + "</div></div>";
  }).join("");
  for (const el of document.querySelectorAll(".card")) el.onclick = () => { $("f-lever").value = $("f-lever").value === el.dataset.lever ? "" : el.dataset.lever; render(); };
}

function render() {
  const rows = filtered();
  cards(DATA.filter(passesOthers)); // every row type, so the cards compare them side by side
  $("count").textContent = rows.length + " shown" + (searchFilter ? " · one search (" + searchFilter + ") · " : "");
  if (searchFilter) $("count").insertAdjacentHTML("beforeend", '<span class="link" id="clear-search">show all</span>');
  if ($("clear-search")) $("clear-search").onclick = () => { searchFilter = ""; render(); };
  if (!rows.length) { $("table").innerHTML = '<div class="empty">Nothing matches these filters yet.</div>'; return; }
  $("table").innerHTML = '<div class="row head"><div>When</div><div>User</div><div>Row</div><div>Score</div><div>Notes</div></div>' +
    rows.map((d) => {
      const notes = d.checks.filter((c) => !c.ok).map((c) => c.item + ": " + c.note).join(" · ") || d.checks.map((c) => c.note).join(" · ");
      return '<div class="row" data-id="' + d.id + '"><div>' + when(d.at) + "</div><div>" + esc(d.user) + "</div><div>" + esc(LEVERS[d.lever]?.name ?? d.lever) +
        '</div><div><span class="badge b-' + d.score + '">' + d.score + '</span></div><div class="why">' + esc(notes) + "</div></div>" +
        (open === d.id ? detail(d) : "");
    }).join("");
  for (const el of document.querySelectorAll(".row[data-id]")) el.onclick = () => { open = open === el.dataset.id ? null : el.dataset.id; render(); };
  for (const el of document.querySelectorAll("[data-search]")) el.onclick = (e) => { e.stopPropagation(); searchFilter = el.dataset.search; open = null; render(); };
}

// The other filters (score, user, dates, text), so the cards can show every row type at once.
function passesOthers(d) {
  const score = $("f-score").value, user = $("f-user").value, from = $("f-from").value, to = $("f-to").value, text = $("f-text").value.toLowerCase();
  return (!score || d.score === score) && (!user || d.user === user) && (!from || day(d.at) >= from) && (!to || day(d.at) <= to) &&
    (!searchFilter || d.search === searchFilter) && (!text || (d.input + d.output + JSON.stringify(d.checks)).toLowerCase().includes(text));
}

function detail(d) {
  return '<div class="detail"><ul class="checks">' +
    d.checks.map((c) => '<li><span class="' + (c.ok ? "ok" : "no") + '">' + (c.ok ? "✓" : "✗") + "</span> <b>" + esc(c.item) + "</b> — " + esc(c.note) + "</li>").join("") +
    "</ul><div class=count>Judged by: " + esc(d.judgedBy.replace("_", " ")) + " · last updated " + when(d.updatedAt) +
    (d.search ? ' · <span class="link" data-search="' + esc(d.search) + '">see all rows for this search</span>' : "") + "</div><br>" +
    '<div class="io"><div><h3>Input</h3><pre>' + esc(pretty(d.input)) + "</pre></div><div><h3>Output</h3><pre>" + esc(pretty(d.output)) + "</pre></div></div></div>";
}

for (const id of ["f-lever", "f-score", "f-user", "f-from", "f-to"]) $(id).onchange = render;
$("f-text").oninput = render;
render();
</script>
</body>
</html>`;

const prod = process.argv.includes("--prod");
const rows = [];
let cursor = null;
for (;;) {
  const args = ["convex", "run", ...(prod ? ["--prod"] : []), "evals:page", JSON.stringify({ paginationOpts: { numItems: 200, cursor } })];
  const page = JSON.parse(execFileSync("npx", args, { maxBuffer: 256 * 1024 * 1024 }).toString());
  rows.push(...page.page);
  if (page.isDone) break;
  cursor = page.continueCursor;
}

const maskPhone = (phone) => (phone.startsWith("1555") ? `test …${phone.slice(-4)}` : `…${phone.slice(-4)}`);
const data = rows.map((r) => ({
  id: r._id,
  at: r._creationTime,
  updatedAt: r.updatedAt,
  user: maskPhone(r.phone),
  lever: r.lever,
  search: r.searchId ? r.searchId.slice(-6) : "",
  score: r.score,
  judgedBy: r.judgedBy,
  checks: r.checks,
  input: r.input,
  output: r.output,
}));

mkdirSync("dashboard", { recursive: true });
const html = TEMPLATE.replace("__DATA__", JSON.stringify(data).replace(/</g, "\\u003c")).replace("__BUILT__", new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }));
writeFileSync("dashboard/evals.html", html);
console.log(`Wrote dashboard/evals.html with ${data.length} scored outputs.`);
try {
  execFileSync("open", ["dashboard/evals.html"]);
} catch {
  // not on a Mac: open the file yourself
}

