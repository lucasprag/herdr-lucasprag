// Status bar: machine, branch, agents, and the remaining Claude / Codex usage
// (session, weekly, Fable weekly; Codex 5h and weekly), as Orca's bar shows it.
// Clicking the usage opens a popup (this mod again, props().usage): one row per
// provider, and the hovered one's details (account, every window, credits).
// Both copies read the last fetch from shared "lucasprag-status.usage".
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, exec, readTextFile, home, shared, setShared, openOverlay, closeOverlay, props } from "herdr";

const REFRESH = 5 * 60000;
const KEY = "lucasprag-status.usage";
const SIGNIN = "lucasprag-status.signin"; // { id, until } while a sign-in tab is open
const POP_W = 340, POP_H = 600;

// "3h 50m", "2d 17h", "45m"; "now" once past. Two largest non-zero parts.
function until(ms) {
  if (!(ms > 0)) return null;
  const s = Math.max(0, Math.round((ms - Date.now()) / 1000));
  if (s === 0) return "now";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m && !d) parts.push(`${m}m`);
  if (!parts.length) parts.push("<1m");
  return parts.slice(0, 2).join(" ");
}

const pct = (used) => (typeof used === "number" && Number.isFinite(used) ? Math.max(0, Math.min(100, Math.round(100 - used))) : null);
const iso = (s) => { const t = Date.parse(s ?? ""); return Number.isFinite(t) ? t : null; };
const unix = (n) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n * 1000 : null);

async function fetchClaude() {
  const r = await exec("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
  if (r.code !== 0) throw new Error("keychain");
  const token = JSON.parse(r.stdout.trim())?.claudeAiOauth?.accessToken;
  if (!token) throw new Error("no token");
  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.0" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const fable = (j.limits ?? []).find((l) => l?.kind === "weekly_scoped" && (l.scope?.model?.display_name ?? "").toLowerCase() === "fable");
  const money = (m) => (m && typeof m.amount_minor === "number" ? m.amount_minor / 10 ** (m.exponent ?? 2) : null);
  const spend = j.spend?.enabled ? { used: money(j.spend.used), limit: money(j.spend.limit), left: pct(j.spend.percent) } : null;
  let email = null;
  try { email = JSON.parse((await readTextFile(`${home()}/.claude.json`)) ?? "{}")?.oauthAccount?.emailAddress ?? null; } catch {}
  return {
    email,
    session: { left: pct(j.five_hour?.utilization), at: iso(j.five_hour?.resets_at) },
    weekly: { left: pct(j.seven_day?.utilization), at: iso(j.seven_day?.resets_at) },
    fable: fable ? { left: pct(fable.percent), at: iso(fable.resets_at) } : null,
    credits: spend && spend.limit !== null ? spend : null,
  };
}

// The email inside Codex's id_token (a JWT; base64url, no atob here).
function jwtEmail(token) {
  try {
    const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const part = token.split(".")[1];
    let bits = 0, n = 0, out = "";
    for (const ch of part) {
      const v = abc.indexOf(ch);
      if (v < 0) continue;
      n = (n << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; out += String.fromCharCode((n >> bits) & 255); }
    }
    return JSON.parse(out)?.email ?? null;
  } catch { return null; }
}

async function fetchCodex() {
  const text = await readTextFile(`${home()}/.codex/auth.json`);
  const tokens = text ? JSON.parse(text)?.tokens : null;
  if (!tokens?.access_token) throw new Error("no token");
  const headers = { Authorization: `Bearer ${tokens.access_token}`, "User-Agent": "codex-cli", "OpenAI-Beta": "codex-1", originator: "Codex Desktop" };
  if (tokens.account_id) headers["ChatGPT-Account-Id"] = tokens.account_id;
  const res = await fetch("https://chatgpt.com/backend-api/wham/usage", { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const w = (x) => (x ? { left: pct(x.used_percent), at: unix(x.reset_at) } : null);
  const c = j.credits;
  return {
    email: jwtEmail(tokens.id_token ?? ""),
    session: w(j.rate_limit?.primary_window), weekly: w(j.rate_limit?.secondary_window),
    balance: c?.unlimited ? "Unlimited" : c?.has_credits && c.balance != null ? `${c.balance}` : null,
  };
}

const usage = () => shared(KEY) ?? {};
let inFlight = false;

// Fetches both and stores them in shared, keeping the last good value per provider.
async function refreshUsage() {
  if (inFlight) return;
  inFlight = true;
  setShared(KEY, { ...usage(), loading: true });
  try {
    const [c, x] = await Promise.allSettled([fetchClaude(), fetchCodex()]);
    const u = usage();
    setShared(KEY, {
      claude: c.status === "fulfilled" ? c.value : u.claude ?? null,
      codex: x.status === "fulfilled" ? x.value : u.codex ?? null,
      claudeError: c.status !== "fulfilled",
      codexError: x.status !== "fulfilled",
      at: c.status === "fulfilled" || x.status === "fulfilled" ? Date.now() : u.at ?? null,
      loading: false,
    });
  } finally { inFlight = false; }
}

function ago(ms) {
  if (!ms) return "Not updated yet";
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return "Updated just now";
  if (m < 60) return `Updated ${m}m ago`;
  return `Updated ${Math.floor(m / 60)}h ago`;
}

const LOGIN = { claude: ["claude", "auth", "login"], codex: ["codex", "login"] };

export default class SmileStatus extends View {
  init(_props, cx) {
    this.popup = Boolean(props()?.usage || props()?.overlay); // any overlay copy is the popup
    this.press = null; this.barWidth = 0;
    cx.timer.every(60000, (cx) => cx.notify()); // the countdowns
    if (this.popup) return;
    this.refresh(cx);
    cx.timer.every(REFRESH, (cx) => this.refresh(cx));
    cx.timer.every(10000, (cx) => {
      const pending = shared(SIGNIN);
      if (!pending) return;
      if (Date.now() > pending.until) { setShared(SIGNIN, null); return; }
      cx.spawn(async () => {
        await refreshUsage();
        if (!usage()[`${pending.id}Error`]) setShared(SIGNIN, null);
      });
    });
  }

  refresh(cx) {
    cx.spawn(async () => { await refreshUsage(); });
  }

  // Opens a tab running the provider's login. The status bar (not this copy:
  // the popup closes now) then refreshes every 10 s for up to 5 minutes
  // until that provider's usage loads; see the timer in init().
  signIn(id) {
    if (this.popup) closeOverlay(props().overlay);
    const space = spaces().find((s) => s.active);
    const name = id === "codex" ? "Codex" : "Claude";
    run("tab.new", { name: `${name} sign in`, ...(space ? { space: space.id } : {}), argv: LOGIN[id] });
    setShared(SIGNIN, { id, until: Date.now() + 5 * 60000 });
  }

  // "Sign in" as a link; it stops the press so the clickable usage around it doesn't open the popup too.
  signInLink(t, id, text) {
    return div().id(`signin-${id}`).flex_none().text_color(t.accent).cursor_pointer()
      .hover((s) => s.underline())
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => this.signIn(id))
      .child(text);
  }

  openUsage() {
    const w = POP_W;
    const p = this.press;
    let at = "pointer";
    if (p) {
      let x = p.x;
      if (this.barWidth) x = Math.max(8, Math.min(x, this.barWidth - w - 8));
      at = { x, y: Math.max(8, p.top - POP_H - 4) };
    }
    openOverlay({ frame: "none", mod: "lucasprag-status", kind: "popup", width: w, height: POP_H, at, props: { usage: true } });
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint() {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  tone(t, left) {
    if (left === null) return t.dim;
    return left < 15 ? t.blocked : left < 30 ? t.working : t.foreground;
  }

  bar(t, left) {
    const share = left === null ? 0 : left / 100;
    return div().w(44).h(5).flex_none().rounded(1).bg(t.raised).overflow_hidden()
      .child(div().h_full().w(44 * share).rounded(1).bg(left !== null && left < 15 ? t.blocked : t.accent));
  }

  window(t, w, suffix) {
    if (!w || w.left === null) return null;
    const when = suffix ?? until(w.at);
    return h_flex().gap(4).items_center().flex_none()
      .child(div().text_color(this.tone(t, w.left)).child(`${w.left}%`))
      .when(Boolean(when), (el) => el.child(div().text_color(t.muted).child(when)));
  }

  provider(t, icon, label, data, error, windows) {
    const row = h_flex().gap(6).items_center().flex_none().child(image(icon).size(13).flex_none());
    if (!data) return error
      ? row.child(div().text_color(t.dim).child(`${label}:`)).child(this.signInLink(t, label.toLowerCase(), "Sign in"))
      : row.child(div().text_color(t.dim).child(`${label}: …`));
    row.child(this.bar(t, data.session?.left ?? null));
    let first = true;
    for (const w of windows) {
      const el = this.window(t, w.data, w.suffix);
      if (!el) continue;
      if (!first) row.child(div().text_color(t.dim).child("·"));
      row.child(el);
      first = false;
    }
    return row;
  }

  refreshButton(t, id, loading) {
    return div().id(id).flex_none().text_color(loading ? t.muted : t.dim).hover((s) => s.text_color(t.foreground)).cursor_pointer()
      .tooltip(loading ? "Refreshing…" : "Refresh usage")
      .on_click((_e, cx) => this.refresh(cx))
      .child(svg("mods/lucasprag-status/refresh.svg").size(13));
  }

  // A full-width meter: label, bar, "x% left" and when it resets.
  meter(t, label, leftText, rightText, left) {
    const bar = div().w_full().h(6).bg(t.raised).overflow_hidden()
      .child(div().h_full().w(`${left ?? 0}%`).bg(left !== null && left < 15 ? t.blocked : t.accent));
    return v_flex().gap(6).w_full()
      .child(div().text_color(t.foreground).child(label))
      .child(bar)
      .child(h_flex().justify_between().text_size(11.5).text_color(t.muted)
        .child(div().text_color(this.tone(t, left)).child(leftText)).child(div().child(rightText ?? "")));
  }

  providers(u) {
    const c = u.claude, x = u.codex;
    return [
      { id: "claude", name: "Claude", icon: "icons/claude.svg", data: c, error: u.claudeError,
        meters: [["Session", c?.session], ["Weekly", c?.weekly], ["Fable", c?.fable]],
        credits: c?.credits ?? null },
      { id: "codex", name: "Codex", icon: "icons/codex.svg", data: x, error: u.codexError,
        meters: [["Session", x?.session], ["Weekly", x?.weekly]],
        extra: x?.balance ? ["Credits", x.balance] : null },
    ];
  }

  // One provider: its name and account, then every window it reports.
  section(t, p) {
    const body = v_flex().w_full().px(14).pb(14).gap(12);
    if (!p.data) body.child(p.error
      ? h_flex().gap(4).child(this.signInLink(t, p.id, `Sign in to ${p.name}`)).child(div().text_color(t.dim).child("to see usage."))
      : div().text_color(t.dim).child("Loading…"));
    for (const [label, w] of p.meters) {
      if (!w || w.left === null) continue;
      const r = until(w.at);
      body.child(this.meter(t, label, `${w.left}% left`, r ? `Resets in ${r}` : null, w.left));
    }
    if (p.credits) {
      const money = (n) => `$${n.toFixed(2)}`;
      body.child(this.meter(t, "Usage credits", `${money(p.credits.used ?? 0)} / ${money(p.credits.limit)}`,
        p.credits.left !== null ? `${p.credits.left}% left` : null, p.credits.left));
    }
    if (p.extra) body.child(h_flex().justify_between().child(div().text_color(t.foreground).child(p.extra[0])).child(div().text_color(t.muted).child(p.extra[1])));
    return v_flex().w_full().flex_none()
      .child(h_flex().h(36).px(14).gap(8).items_center().flex_none()
        .child(image(p.icon).size(14).flex_none())
        .child(div().text_color(t.foreground).font_medium().child(p.name))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(p.data?.email ?? "")))
      .child(body);
  }

  // One panel: a header, then Claude and Codex one under the other.
  usagePopup(t) {
    const u = usage();
    const line = () => div().h(1).w_full().flex_none().bg(t.border);
    const sections = this.providers(u).flatMap((p, i) => (i ? [line(), this.section(t, p)] : [this.section(t, p)]));
    const panel = v_flex().w(POP_W).flex_none().rounded(4).overflow_hidden().bg(t.popover).border_1().border_color(t.border).shadow_lg()
      .child(h_flex().h(38).px(14).gap(8).items_center().flex_none()
        .child(div().flex_1().text_color(t.foreground).font_medium().child("Usage"))
        .child(div().text_size(11.5).text_color(t.dim).child(u.loading ? "Updating…" : ago(u.at)))
        .child(this.refreshButton(t, "popup-refresh", u.loading)))
      .child(line())
      .children(sections);
    // A fixed box with the panel at its bottom: Herdr sizes a popup to its
    // content from a fixed top, so a panel that grows or shrinks (sign in,
    // loading) would otherwise move away from the status bar.
    return v_flex().w(POP_W).h(POP_H).flex_none().justify_end().text_size(12.5).child(panel);
  }

  render() {
    const t = theme();
    const space = spaces().find((s) => s.active);
    const list = agents();
    const needs = list.filter((a) => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().flex_none().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    if (this.popup) return this.usagePopup(t);
    const u = usage();
    const c = u.claude ?? null, x = u.codex ?? null;
    return h_flex().size_full().on_size_change((size) => { this.barWidth = size.width; }).min_w(0).px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), (el) => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().flex_none().child(div().size(6).rounded(1).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, (el) => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(h_flex().gap(2).h_full().items_center().flex_none()
        .child(h_flex().id("usage").h_full().px(8).ml(-8).gap(10).items_center().flex_none().cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_mouse_down("left", (e) => {
            const lx = e.local_position?.x ?? 0, ly = e.local_position?.y ?? 0;
            this.press = { x: e.position.x - lx, top: e.position.y - ly };
          })
          .on_click(() => this.openUsage())
          .child(div().text_color(t.dim).child("Remaining"))
          .child(this.provider(t, "icons/claude.svg", "Claude", c, u.claudeError, [
            { data: c?.session }, { data: c?.weekly }, { data: c?.fable, suffix: "Fable" },
          ]))
          .child(this.provider(t, "icons/codex.svg", "Codex", x, u.codexError, [
            { data: x?.session }, { data: x?.weekly },
          ])))
        .child(this.refreshButton(t, "usage-refresh", u.loading)))
      .child(div().flex_1())
      .child(div().id("palette").flex_none().text_color(t.dim).on_click(() => run("app.palette")).child(this.hint()));
  }
}
