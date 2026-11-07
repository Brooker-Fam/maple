/**
 * The activity view's style and script, as the host's frame runs them
 * (activity.ts puts them in the page). Plain, bundler-free browser code: it
 * builds every element with createElement and puts every piece of text in
 * with textContent, so nothing from a result is ever read as markup; it
 * makes no requests and sends the host only the MCP Apps handshake
 * (ui/initialize, then ui/notifications/initialized), its size and answers
 * to the host's own requests.
 *
 * The script runs after activity.ts's `activityDays`, `activityModel`,
 * `TIER_OF` (a tier label to its look) and `PROTOCOL`, in one function scope.
 */

/** The app's colors (src/app/maple/maple.css: `:root` by day, `.dark`); a check holds them equal. */
export const MP_TOKENS = {
  light: {
    "--mp-font": 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    "--mp-bg": "#f6f3ec",
    "--mp-surface": "#ffffff",
    "--mp-sunken": "#eeeae1",
    "--mp-raised": "#ffffff",
    "--mp-ink": "#1c2619",
    "--mp-ink-2": "#5b6356",
    "--mp-ink-3": "#686d61",
    "--mp-line": "rgb(28 38 25 / 0.1)",
    "--mp-edge": "transparent",
    "--mp-accent": "#1d4420",
    "--mp-on-accent": "#ffffff",
    "--mp-accent-fg": "#2c5a2f",
    "--mp-maple": "#b5452b",
    "--mp-danger": "#a63a22",
    "--mp-focus": "#c49a3c",
    "--mp-toast": "#1c2619",
    "--mp-on-toast": "#f6f3ec",
  },
  dark: {
    "--mp-bg": "#0e1310",
    "--mp-surface": "#171d18",
    "--mp-sunken": "#222a23",
    "--mp-raised": "#333d35",
    "--mp-ink": "#ece7dc",
    "--mp-ink-2": "#a7aba0",
    "--mp-ink-3": "#878e83",
    "--mp-line": "rgb(236 231 220 / 0.09)",
    "--mp-edge": "rgb(236 231 220 / 0.09)",
    "--mp-accent": "#b4cc96",
    "--mp-on-accent": "#16210f",
    "--mp-accent-fg": "#b9d29c",
    "--mp-maple": "#e5895e",
    "--mp-danger": "#f09a80",
    "--mp-focus": "#d9b76a",
    "--mp-toast": "#2a322b",
    "--mp-on-toast": "#ece7dc",
  },
} as const;

/** The alert looks AlertCard.tsx gives "call now" and "call today" (tier colors are information; there's no token for today's amber). */
const TIER_COLORS = {
  light: { "--now-mix": "9%", "--today-ink": "#a35a0c", "--today-wash": "#d9822b", "--today-edge": "rgb(217 130 43 / 0.45)", "--today-mix": "10%" },
  dark: { "--now-mix": "13%", "--today-ink": "#eba35c", "--today-wash": "#eba35c", "--today-edge": "rgb(235 163 92 / 0.35)", "--today-mix": "12%" },
} as const;

const vars = (...sets: Record<string, string>[]) =>
  sets
    .flatMap((set) => Object.entries(set))
    .map(([name, value]) => `${name}: ${value};`)
    .join(" ");

const DARK = `color-scheme: dark; ${vars(MP_TOKENS.dark, TIER_COLORS.dark)}`;

export const ACTIVITY_CSS = `
:root { color-scheme: light; ${vars(MP_TOKENS.light, TIER_COLORS.light)} }
:root[data-theme="dark"] { ${DARK} }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${DARK} } }
* { box-sizing: border-box; }
html, body { margin: 0; background: transparent; }
body {
  padding: var(--inset-top, 0px) var(--inset-right, 0px) var(--inset-bottom, 0px) var(--inset-left, 0px);
  font-family: var(--mp-font); font-size: 14px; line-height: 1.4; color: var(--mp-ink);
  -webkit-font-smoothing: antialiased; -webkit-text-size-adjust: 100%; text-size-adjust: 100%;
}
.card { min-width: 0; padding: 14px; border: 1px solid var(--mp-line); border-radius: 20px; background: var(--mp-surface); }
.title { margin: 0; font-size: 16px; font-weight: 600; line-height: 1.3; letter-spacing: -0.01em; }
.subtitle { margin: 4px 0 0; font-size: 12px; line-height: 1.35; color: var(--mp-ink-3); }
.title, .subtitle, .alert { overflow-wrap: anywhere; }
.notice { margin: 8px 0 2px; font-size: 14px; line-height: 1.45; color: var(--mp-ink-2); }
.skeleton { height: 148px; margin-top: 12px; border-radius: 16px; background: var(--mp-sunken); }
.seg { display: flex; flex-wrap: wrap; margin-top: 12px; padding: 2px; border-radius: 12px; background: var(--mp-sunken); }
.seg--range { max-width: 200px; margin-top: 8px; }
.seg button { flex: 1 1 0; min-width: 0; min-height: 44px; padding: 0 12px; border: 0; border-radius: 10px; background: transparent; color: var(--mp-ink-2); font: inherit; font-size: 14px; font-weight: 500; cursor: pointer; }
.seg button[aria-checked="true"] { background: var(--mp-raised); color: var(--mp-ink); font-weight: 600; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12); }
button:focus-visible, summary:focus-visible, .bars:focus-visible { outline: 2px solid var(--mp-focus); outline-offset: 2px; }
.legend { display: flex; gap: 12px; margin-top: 8px; font-size: 12px; color: var(--mp-ink-2); }
.legend-item { display: inline-flex; align-items: center; gap: 6px; }
.swatch { width: 10px; height: 10px; border-radius: 2px; background: var(--mp-accent-fg); }
.swatch--wet { opacity: 0.35; }
.swatch--dirty { opacity: 0.9; }
.bars { display: block; width: 100%; height: auto; margin-top: 12px; overflow: visible; border-radius: 8px; touch-action: pan-y; }
.grid { stroke: var(--mp-line); }
.axis { fill: var(--mp-ink-3); font-family: var(--mp-font); font-size: 10px; }
.bar { fill: var(--mp-accent-fg); opacity: 0.9; }
.bar--partial { opacity: 0.5; }
.wet { fill: var(--mp-accent-fg); opacity: 0.35; }
.dirty { fill: var(--mp-accent-fg); opacity: 0.9; }
.missing { stroke: var(--mp-ink-3); stroke-dasharray: 2 2; }
.pick { fill: var(--mp-accent-fg); opacity: 0.08; }
.hit { fill: transparent; cursor: pointer; }
.nav { display: flex; align-items: center; gap: 4px; min-height: 60px; margin-top: 8px; padding: 4px 6px; border-radius: 16px; background: var(--mp-sunken); }
.nav-btn { display: flex; flex: none; align-items: center; justify-content: center; width: 44px; height: 44px; padding: 0; border: 0; border-radius: 12px; background: transparent; color: var(--mp-ink-2); cursor: pointer; }
.nav-btn:disabled { opacity: 0.25; cursor: default; }
.nav-info { flex: 1; min-width: 0; text-align: center; }
.nav-day { margin: 0; font-size: 12px; color: var(--mp-ink-2); }
.nav-value { margin: 2px 0 0; font-size: 14px; font-weight: 500; font-variant-numeric: tabular-nums; }
.data { margin-top: 8px; }
.data summary { display: flex; align-items: center; min-height: 44px; font-size: 13px; font-weight: 500; color: var(--mp-accent-fg); cursor: pointer; }
table { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
th, td { padding: 8px 0; border-bottom: 1px solid var(--mp-line); text-align: left; font-weight: 400; }
thead th { font-weight: 500; }
.num { text-align: right; }
tbody tr:last-child th, tbody tr:last-child td { border-bottom: 0; }
.help { margin: 8px 0 0; font-size: 12px; line-height: 1.35; color: var(--mp-ink-3); }
.day-list { margin: 12px 0 0; padding: 2px 12px; border-radius: 16px; background: var(--mp-sunken); }
.day-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 44px; padding: 8px 0; border-bottom: 1px solid var(--mp-line); }
.day-row:last-child { border-bottom: 0; }
.day-row dt { color: var(--mp-ink-2); }
.day-row dd { margin: 0; font-size: 15px; font-weight: 500; font-variant-numeric: tabular-nums; text-align: right; }
.flagged { display: grid; gap: 8px; margin-top: 12px; }
.flagged-head { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 13px; font-weight: 600; color: var(--mp-ink-2); }
.alert { padding: 10px 12px; border: 1px solid var(--mp-line); border-radius: 16px; background: var(--mp-surface); }
.alert--now { border-color: color-mix(in srgb, var(--mp-danger) 40%, transparent); background: color-mix(in srgb, var(--mp-danger) var(--now-mix), var(--mp-surface)); }
.alert--today { border-color: var(--today-edge); background: color-mix(in srgb, var(--today-wash) var(--today-mix), var(--mp-surface)); }
.alert--emergency { border-color: transparent; background: #9b2419; color: #ffffff; }
.alert-tier { margin: 0; font-size: 13px; font-weight: 600; color: var(--mp-accent-fg); }
.alert--now .alert-tier { color: var(--mp-danger); }
.alert--today .alert-tier { color: var(--today-ink); }
.alert-title { margin: 4px 0 0; font-size: 15px; font-weight: 600; line-height: 1.3; }
.alert-events { margin: 4px 0 0; padding: 0; list-style: none; font-size: 13px; line-height: 1.4; color: var(--mp-ink-2); }
.alert-events li + li { margin-top: 2px; }
.alert--emergency .alert-tier, .alert--emergency .alert-events { color: inherit; }
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
`;

export const ACTIVITY_FRAME_JS = `
const root = document.getElementById("view");
const SVG_NS = "http://www.w3.org/2000/svg";
const W = 320, H = 156, LEFT = 36, RIGHT = 12, TOP = 12, BOTTOM = 128;
const TITLE = "Activity over time";
const NO_LOG = "No logs";
const UNREADABLE = "This summary can't be drawn as a chart here. Everything in it is in the conversation.";
const INIT_ID = 1;
const LOUDEST = { emergency: 0, now: 1, today: 2, mention: 3 };
const embedded = window.parent !== window;
const view = { key: null, shown: false, metric: "feeds", range: 0, picked: "", tableOpen: false };
const size = { initialized: false, watching: false, queued: false, width: 0, height: 0 };

function post(message) {
  if (embedded) window.parent.postMessage(message, "*");
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svg(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.keys(attrs).forEach(function (name) { node.setAttribute(name, String(attrs[name])); });
  return node;
}

function icon(shapes) {
  const node = svg("svg", { viewBox: "0 0 24 24", width: 18, height: 18, fill: "none", stroke: "currentColor", "stroke-width": 1.75, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" });
  shapes.forEach(function (shape) { node.appendChild(svg(shape[0], shape[1])); });
  return node;
}

const CHEVRON_LEFT = [["path", { d: "m15 18-6-6 6-6" }]];
const CHEVRON_RIGHT = [["path", { d: "m9 18 6-6-6-6" }]];
const CIRCLE_ALERT = [["circle", { cx: 12, cy: 12, r: 10 }], ["line", { x1: 12, x2: 12, y1: 8, y2: 12 }], ["line", { x1: 12, x2: 12.01, y1: 16, y2: 16 }]];

const SHORT_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const LONG_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function dayLabel(date, long) {
  return (long ? LONG_DAY : SHORT_DAY).format(new Date(date + "T12:00:00Z"));
}

function amount(day, metric) {
  if (metric === "feeds") return day.feeds;
  if (metric === "sleep") return day.sleepHours;
  return day.wet === null || day.dirty === null ? null : day.wet + day.dirty;
}

function detail(day, metric) {
  if (amount(day, metric) === null) return NO_LOG;
  if (metric === "sleep") return day.sleepHours + " h logged";
  if (metric === "diapers") return day.wet + " wet · " + day.dirty + " dirty";
  return day.feeds + " feed" + (day.feeds === 1 ? "" : "s") + " logged";
}

function helpLine(diapers) {
  return "Only logged activity. Missing logs are not zero activity." + (diapers ? " A diaper can count as both wet and dirty." : "");
}

function card(title, subtitle) {
  const section = el("section", "card");
  section.setAttribute("aria-label", title);
  section.appendChild(el("h1", "title", title));
  if (subtitle) section.appendChild(el("p", "subtitle", subtitle));
  return section;
}

function place(section) {
  root.textContent = "";
  root.appendChild(section);
  if (size.watching) sendSize();
}

function notice(text) {
  const section = card(TITLE);
  section.appendChild(el("p", "notice", text));
  place(section);
}

function levelOf(tier) {
  const own = Object.prototype.hasOwnProperty;
  return own.call(TIER_OF, tier) && own.call(LOUDEST, TIER_OF[tier]) ? TIER_OF[tier] : "mention";
}

/* Flagged events, word for word: one card per tier and title, loudest first, each event's "what at when" under it, as the summary's text has it. */
function flaggedList(alerts) {
  const groups = [];
  alerts.forEach(function (alert) {
    let group = groups.find(function (g) { return g.tier === alert.tier && g.title === alert.title; });
    if (!group) {
      group = { tier: alert.tier, title: alert.title, level: levelOf(alert.tier), events: [] };
      groups.push(group);
    }
    group.events.push(alert.what + " at " + alert.when);
  });
  groups.sort(function (a, b) { return LOUDEST[a.level] - LOUDEST[b.level]; });
  const box = el("section", "flagged");
  box.setAttribute("aria-label", "Flagged");
  const head = el("h2", "flagged-head");
  head.appendChild(icon(CIRCLE_ALERT));
  head.appendChild(el("span", "", "Flagged"));
  box.appendChild(head);
  groups.forEach(function (group) {
    const item = el("div", "alert alert--" + group.level);
    item.appendChild(el("p", "alert-tier", group.tier));
    item.appendChild(el("p", "alert-title", group.title));
    const events = el("ul", "alert-events");
    group.events.forEach(function (text) { events.appendChild(el("li", "", text)); });
    item.appendChild(events);
    box.appendChild(item);
  });
  return box;
}

function segmented(label, options, selected, onPick) {
  const group = el("div", "seg");
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", label);
  const buttons = [];
  function mark(value) {
    buttons.forEach(function (button, i) {
      const on = options[i].value === value;
      button.setAttribute("aria-checked", on ? "true" : "false");
      button.tabIndex = on ? 0 : -1;
    });
  }
  options.forEach(function (option, index) {
    const button = el("button", "", option.label);
    button.type = "button";
    button.setAttribute("role", "radio");
    button.addEventListener("click", function () { mark(option.value); onPick(option.value); });
    button.addEventListener("keydown", function (event) {
      const last = options.length - 1;
      const next = event.key === "Home" ? 0 : event.key === "End" ? last
        : event.key === "ArrowRight" || event.key === "ArrowDown" ? (index + 1) % options.length
        : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (index + last) % options.length : -1;
      if (next < 0) return;
      event.preventDefault();
      mark(options[next].value);
      onPick(options[next].value);
      buttons[next].focus();
    });
    buttons.push(button);
    group.appendChild(button);
  });
  mark(selected);
  return group;
}

function navButton(label, shapes) {
  const button = el("button", "nav-btn");
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.appendChild(icon(shapes));
  return button;
}

/* The in-app chart (ChatChart.tsx): the same scale, bars, missing-log dashes, picked day and data table. */
function plot(body, days, metric) {
  if (metric === "diapers") {
    const legend = el("div", "legend");
    [["wet", "Wet"], ["dirty", "Dirty"]].forEach(function (pair) {
      const item = el("span", "legend-item");
      const swatch = el("span", "swatch swatch--" + pair[0]);
      swatch.setAttribute("aria-hidden", "true");
      item.appendChild(swatch);
      item.appendChild(document.createTextNode(pair[1]));
      legend.appendChild(item);
    });
    body.appendChild(legend);
  }
  const peak = Math.max.apply(null, [1].concat(days.map(function (day) { const n = amount(day, metric); return n === null ? 0 : n; })));
  const ceiling = metric === "sleep" ? Math.max(2, Math.ceil(peak / 2) * 2) : Math.max(2, Math.ceil(peak / 4) * 4);
  const slot = (W - LEFT - RIGHT) / Math.max(1, days.length);
  const bar = Math.min(22, slot * 0.64);
  function y(n) { return BOTTOM - n / ceiling * (BOTTOM - TOP); }
  function x(i) { return LEFT + slot * (i + 0.5); }
  const what = metric === "sleep" ? "Logged sleep in hours" : metric === "diapers" ? "Wet and dirty diaper counts" : "Logged feeds";
  const chart = svg("svg", { viewBox: "0 0 " + W + " " + H, class: "bars", role: "group", tabindex: 0, "aria-label": what + ", " + days.length + " days. Use the arrow keys to explore.", "aria-describedby": "chart-help" });
  [0, ceiling / 2, ceiling].forEach(function (tick) {
    chart.appendChild(svg("line", { x1: LEFT, x2: W - RIGHT, y1: y(tick), y2: y(tick), class: "grid" }));
    const label = svg("text", { x: LEFT - 6, y: y(tick), dy: "0.32em", "text-anchor": "end", class: "axis" });
    label.textContent = tick + (metric === "sleep" ? "h" : "");
    chart.appendChild(label);
  });
  const highlight = svg("rect", { x: 0, y: TOP - 6, width: slot, height: BOTTOM - TOP + 12, rx: 4, class: "pick" });
  chart.appendChild(highlight);
  let index = days.length - 1;
  days.forEach(function (day, i) {
    const n = amount(day, metric);
    if (n === null) {
      chart.appendChild(svg("line", { x1: x(i) - 4, x2: x(i) + 4, y1: BOTTOM - 3, y2: BOTTOM - 3, class: "missing" }));
    } else if (metric === "diapers") {
      chart.appendChild(svg("rect", { x: x(i) - bar / 2, y: y(day.wet), width: bar, height: BOTTOM - y(day.wet), rx: 2, class: "wet" }));
      chart.appendChild(svg("rect", { x: x(i) - bar / 2, y: y(n), width: bar, height: y(day.wet) - y(n), rx: 2, class: "dirty" }));
    } else {
      chart.appendChild(svg("rect", { x: x(i) - bar / 2, y: y(n), width: bar, height: Math.max(1, BOTTOM - y(n)), rx: 3, class: day.partial ? "bar bar--partial" : "bar" }));
    }
    const hit = svg("rect", { x: x(i) - slot / 2, y: 0, width: slot, height: H, class: "hit" });
    const tip = svg("title", {});
    tip.textContent = dayLabel(day.date, true) + (day.partial ? ", partial day" : "") + ": " + detail(day, metric);
    hit.appendChild(tip);
    hit.addEventListener("click", function () { pick(i); });
    chart.appendChild(hit);
    if (i === 0 || i === days.length - 1 || (i < days.length - 2 && i % (days.length > 7 ? 4 : 2) === 0)) {
      const label = svg("text", { x: x(i), y: H - 7, "text-anchor": "middle", class: "axis" });
      label.textContent = dayLabel(day.date);
      chart.appendChild(label);
    }
  });
  chart.addEventListener("keydown", function (event) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    pick(Math.min(days.length - 1, Math.max(0, index + (event.key === "ArrowLeft" ? -1 : 1))));
  });
  body.appendChild(chart);

  const nav = el("div", "nav");
  const prev = navButton("Previous day", CHEVRON_LEFT);
  const next = navButton("Next day", CHEVRON_RIGHT);
  const info = el("div", "nav-info");
  info.setAttribute("aria-live", "polite");
  const infoDay = el("p", "nav-day");
  const infoValue = el("p", "nav-value");
  info.appendChild(infoDay);
  info.appendChild(infoValue);
  prev.addEventListener("click", function () { pick(index - 1); });
  next.addEventListener("click", function () { pick(index + 1); });
  nav.appendChild(prev);
  nav.appendChild(info);
  nav.appendChild(next);
  body.appendChild(nav);

  const disclosure = el("details", "data");
  disclosure.open = view.tableOpen;
  disclosure.addEventListener("toggle", function () { view.tableOpen = disclosure.open; if (size.watching) sendSize(); });
  disclosure.appendChild(el("summary", "", "Show data"));
  const table = el("table");
  table.appendChild(el("caption", "sr-only", metric + " logged by day"));
  const head = el("thead");
  const headRow = el("tr");
  [["Day", ""], [metric === "sleep" ? "Logged sleep" : metric === "diapers" ? "Wet / dirty" : "Feeds", "num"]].forEach(function (column) {
    const cell = el("th", column[1], column[0]);
    cell.setAttribute("scope", "col");
    headRow.appendChild(cell);
  });
  head.appendChild(headRow);
  table.appendChild(head);
  const rows = el("tbody");
  days.forEach(function (day) {
    const row = el("tr");
    const name = el("th", "", dayLabel(day.date) + (day.partial ? " (partial)" : ""));
    name.setAttribute("scope", "row");
    row.appendChild(name);
    row.appendChild(el("td", "num", detail(day, metric)));
    rows.appendChild(row);
  });
  table.appendChild(rows);
  disclosure.appendChild(table);
  body.appendChild(disclosure);
  const note = el("p", "help", helpLine(metric === "diapers"));
  note.id = "chart-help";
  body.appendChild(note);

  function pick(i) {
    if (i < 0 || i >= days.length) return;
    index = i;
    view.picked = days[i].date;
    highlight.setAttribute("x", String(x(i) - slot / 2));
    infoDay.textContent = dayLabel(days[i].date) + (days[i].partial ? " · partial day" : "");
    infoValue.textContent = detail(days[i], metric);
    prev.disabled = i <= 0;
    next.disabled = i >= days.length - 1;
  }
  const found = days.findIndex(function (day) { return day.date === view.picked; });
  pick(found < 0 ? days.length - 1 : found);
}

function daysCard(model) {
  const first = model.days[0].date;
  const last = model.days[model.days.length - 1].date;
  const span = dayLabel(first) + " to " + dayLabel(last) + (model.earlier ? " · the last " + model.days.length + " of " + model.summaryDays + " days" : "");
  const section = card(TITLE, span);
  if (model.alerts.length) section.appendChild(flaggedList(model.alerts));
  const body = el("div", "chart");
  function draw() {
    body.textContent = "";
    plot(body, model.days.slice(-view.range), view.metric);
    if (size.watching) sendSize();
  }
  section.appendChild(segmented("Chart metric", [{ value: "feeds", label: "Feeds" }, { value: "sleep", label: "Sleep" }, { value: "diapers", label: "Diapers" }], view.metric, function (value) { view.metric = value; draw(); }));
  if (model.ranges.length > 1) {
    const ranges = segmented("Chart range", model.ranges.map(function (n) { return { value: n, label: n + " days" }; }), view.range, function (value) { view.range = value; draw(); });
    ranges.classList.add("seg--range");
    section.appendChild(ranges);
  }
  section.appendChild(body);
  draw();
  return section;
}

function dayCard(model) {
  const day = model.day;
  const section = card(day.date === model.to ? "Today so far" : "Activity on " + dayLabel(day.date), dayLabel(day.date, true));
  if (model.alerts.length) section.appendChild(flaggedList(model.alerts));
  const list = el("dl", "day-list");
  [["feeds", "Feeds"], ["sleep", "Sleep"], ["diapers", "Diapers"]].forEach(function (pair) {
    const row = el("div", "day-row");
    row.appendChild(el("dt", "", pair[1]));
    row.appendChild(el("dd", "", detail(day, pair[0])));
    list.appendChild(row);
  });
  section.appendChild(list);
  section.appendChild(el("p", "help", helpLine(true)));
  return section;
}

function show(result) {
  let model;
  try { model = activityModel(result, activityDays); } catch (error) { model = { kind: "fallback", reason: "unreadable" }; }
  let key = null;
  try { key = JSON.stringify(model); } catch (error) { key = null; }
  if (key !== null && key === view.key) return;
  view.key = key;
  view.shown = true;
  try {
    if (model.kind === "fallback") {
      notice(model.reason === "error" ? "The summary didn't load, so there's nothing to draw." : UNREADABLE);
      return;
    }
    if (model.kind === "days") {
      view.range = model.ranges[model.ranges.length - 1];
      view.picked = model.to;
    }
    place(model.kind === "day" ? dayCard(model) : daysCard(model));
  } catch (error) {
    notice(UNREADABLE);
  }
}

function context(host) {
  if (!host || typeof host !== "object") return;
  if (host.theme === "light" || host.theme === "dark") document.documentElement.setAttribute("data-theme", host.theme);
  const inset = host.safeAreaInsets;
  if (inset && typeof inset === "object") {
    ["top", "right", "bottom", "left"].forEach(function (side) {
      const n = Number(inset[side]);
      document.documentElement.style.setProperty("--inset-" + side, (Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 0) + "px");
    });
  }
}

/* Height as the ext-apps SDK measures it; ui/notifications/size-changed only once the handshake is done. */
function sendSize() {
  size.queued = false;
  const doc = document.documentElement;
  const before = doc.style.height;
  doc.style.height = "max-content";
  const height = Math.ceil(doc.getBoundingClientRect().height);
  doc.style.height = before;
  const width = Math.ceil(window.innerWidth);
  if (width === size.width && height === size.height) return;
  size.width = width;
  size.height = height;
  if (size.initialized) post({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { width: width, height: height } });
  const openai = window.openai;
  if (openai && typeof openai.notifyIntrinsicHeight === "function") {
    try { openai.notifyIntrinsicHeight(height); } catch (error) { /* the host's own call */ }
  }
}

function measure() {
  if (!size.watching || size.queued) return;
  size.queued = true;
  requestAnimationFrame(sendSize);
}

function watchSize() {
  if (size.watching) return;
  size.watching = true;
  sendSize();
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(measure);
    observer.observe(document.documentElement);
    observer.observe(document.body);
  }
  window.addEventListener("resize", measure);
}

window.addEventListener("message", function (event) {
  if (!embedded || event.source !== window.parent) return;
  const m = event.data;
  if (!m || typeof m !== "object" || m.jsonrpc !== "2.0") return;
  if (m.method === undefined) {
    if (m.id !== INIT_ID || size.initialized) return;
    if (m.result && typeof m.result === "object") {
      context(m.result.hostContext);
      size.initialized = true;
      size.width = 0;
      size.height = 0;
      post({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
      if (size.watching) sendSize();
      else watchSize();
    } else if (!view.shown) {
      notice("This chart can't be shown here. The summary is in the conversation.");
    }
    return;
  }
  if (typeof m.method !== "string") return;
  if (m.id !== undefined && m.id !== null) {
    post(m.method === "ui/resource-teardown" || m.method === "ping"
      ? { jsonrpc: "2.0", id: m.id, result: {} }
      : { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
    return;
  }
  if (m.method === "ui/notifications/tool-result") show(m.params);
  else if (m.method === "ui/notifications/tool-cancelled") { if (!view.shown) notice("The summary was stopped before it finished, so there's nothing to draw."); }
  else if (m.method === "ui/notifications/host-context-changed") context(m.params);
});

/* ChatGPT's Apps SDK globals: the same structuredContent, its theme and its height call. */
function fromOpenAI() {
  const openai = window.openai;
  if (!openai || typeof openai !== "object") return;
  if (openai.theme === "light" || openai.theme === "dark") document.documentElement.setAttribute("data-theme", openai.theme);
  if (openai.toolOutput && typeof openai.toolOutput === "object") show({ structuredContent: openai.toolOutput });
  watchSize();
}
window.addEventListener("openai:set_globals", fromOpenAI);
fromOpenAI();

post({ jsonrpc: "2.0", id: INIT_ID, method: "ui/initialize", params: { appInfo: { name: "activity-view", version: "1.0.0" }, appCapabilities: { availableDisplayModes: ["inline"] }, protocolVersion: PROTOCOL } });
`;
