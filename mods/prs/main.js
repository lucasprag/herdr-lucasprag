// Pull requests: the open PRs on github.com that involve me (last 30 days),
// sorted into what needs my review (mine or my team's), and where my own PRs stand
// (including the ones in a merge queue).
// Data comes from `gh api graphql`; avatars are cached under mods/prs/avatars.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, appHome } from "herdr";
import { mkdir, exists } from "fs/promises";

const QUERY = `query($q: String!) { search(query: $q, type: ISSUE, first: 100) { issueCount nodes { ... on PullRequest {
  number title url isDraft updatedAt createdAt reviewDecision mergeable merged mergedAt closed
  isInMergeQueue mergeQueueEntry { position state }
  repository { nameWithOwner name } author { login avatarUrl }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug combinedSlug } } } }
  latestReviews(first: 20) { nodes { state author { login } } } } } } }`;

const SECTIONS = [
  ["review", "Needs your review"],
  ["action", "Needs action"],
  ["merge", "Ready to merge"],
  ["queue", "In merge queue"],
  ["waiting", "Waiting for review"],
  ["drafts", "Your drafts"],
  ["mergedToday", "Merged today"],
];
const REFRESH_MS = 120000;
const SPIN_MS = 900;
const AVATARS = "mods/prs/avatars";

function sinceDate() {
  const d = new Date(Date.now() - 30 * 86400000);
  return d.toISOString().slice(0, 10);
}

// Local midnight as an ISO time with this machine's offset, so "today" is
// today here and not in UTC.
function localMidnight() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const off = -d.getTimezoneOffset();
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const ymd = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return { ms: d.getTime(), iso: `${ymd}T00:00:00${off >= 0 ? "+" : "-"}${pad(off / 60)}:${pad(off % 60)}` };
}

function age(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

const ciState = (pr) => pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null;

// Which section a PR belongs to, or null when it isn't mine to act on.
function classify(pr, me, teams) {
  const mine = pr.author?.login === me;
  const requests = pr.reviewRequests?.nodes?.map((n) => n.requestedReviewer).filter(Boolean) ?? [];
  const ci = ciState(pr);
  if (mine) {
    if (pr.isInMergeQueue) return "queue";
    if (pr.isDraft) return "drafts";
    if (pr.reviewDecision === "CHANGES_REQUESTED" || pr.mergeable === "CONFLICTING" || ci === "FAILURE" || ci === "ERROR") return "action";
    if (pr.reviewDecision === "APPROVED") return "merge";
    return "waiting";
  }
  if (requests.some((r) => r.__typename === "User" && r.login === me)) return "review";
  const myReview = pr.latestReviews?.nodes?.find((r) => r.author?.login === me)?.state;
  if (requests.some((r) => r.__typename === "Team" && teams.has(r.slug)) && myReview !== "APPROVED") return "review";
  return null;
}

function statusWord(pr) {
  const entry = pr.isInMergeQueue ? pr.mergeQueueEntry : null;
  if (entry) {
    if (entry.state === "UNMERGEABLE") return ["Can't merge", "blocked"];
    if (entry.state === "MERGEABLE") return ["Merging", "done"];
    return [entry.position ? `Queued #${entry.position}` : "Queued", "muted"];
  }
  if (pr.merged) return ["Merged", "done"];
  if (pr.isDraft) return ["Draft", "dim"];
  if (pr.mergeable === "CONFLICTING") return ["Conflicts", "blocked"];
  if (pr.reviewDecision === "CHANGES_REQUESTED") return ["Changes requested", "blocked"];
  if (pr.reviewDecision === "APPROVED") return ["Approved", "done"];
  return ["Review required", "muted"];
}

// The PR icon, as GitHub draws it: gray draft, green open, yellow in the
// merge queue, purple merged, red closed, each with its Octicon (gh-<state>.svg,
// from @primer/octicons 19.15.0). Review and CI state stay in the status word
// and the check mark. GitHub's Primer colors, light and dark.
const GITHUB = {
  dark: { draft: "#9198a1", open: "#3fb950", queued: "#d29922", merged: "#ab7df8", closed: "#f85149" },
  light: { draft: "#59636e", open: "#1a7f37", queued: "#9a6700", merged: "#8250df", closed: "#d1242f" },
};

function prState(pr) {
  if (pr.merged) return "merged";
  if (pr.closed) return "closed";
  if (pr.isInMergeQueue) return "queued";
  if (pr.isDraft) return "draft";
  return "open";
}

function isDark(t) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(t.chrome ?? t.background ?? "");
  if (!m) return true;
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16));
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}

const iconColor = (t, pr) => GITHUB[isDark(t) ? "dark" : "light"][prState(pr)];

export default class PullRequests extends View {
  init(_props, cx) {
    this.sections = null; // { key: [pr, ...] } after the first load
    this.error = null;
    this.loading = true;
    this.folded = new Set();
    this.avatars = {}; // login -> true (cached) | false (failed)
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  async gh(args) {
    const r = await exec("gh", args);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n")[0] || `gh exited ${r.code}`);
    return r.stdout;
  }

  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.notify(); // start the refresh icon spinning now, not when the data lands
    const started = Date.now();
    cx.spawn(async (cx) => {
      try {
        if (!this.me) {
          this.me = (await this.gh(["api", "user", "--jq", ".login"])).trim();
          const teams = (await this.gh(["api", "user/teams", "--jq", ".[].slug"])).split("\n").map((s) => s.trim()).filter(Boolean);
          this.teams = new Set(teams);
        }
        const q = `is:pr is:open involves:@me archived:false updated:>=${sinceDate()}`;
        const midnight = localMidnight();
        const mq = `is:pr is:merged author:@me archived:false merged:>=${midnight.iso}`;
        const [out, mout] = await Promise.all([q, mq].map(async (query) =>
          JSON.parse(await this.gh(["api", "graphql", "-F", `q=${query}`, "-F", `query=${QUERY}`]))));
        const nodes = (out.data?.search?.nodes ?? []).filter((n) => n && n.number);
        const merged = (mout.data?.search?.nodes ?? []).filter((n) => n && n.number && Date.parse(n.mergedAt) >= midnight.ms);
        const sections = Object.fromEntries(SECTIONS.map(([k]) => [k, []]));
        for (const pr of nodes) {
          const key = classify(pr, this.me, this.teams);
          if (key) sections[key].push(pr);
        }
        for (const list of Object.values(sections)) list.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
        sections.mergedToday = merged.sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
        if (!this.sections) for (const [k] of SECTIONS) if (sections[k].length === 0) this.folded.add(k);
        // The queue and today's merges fill up during the day, so open them when PRs land in them.
        for (const k of ["queue", "mergedToday"]) if (this.sections && this.sections[k].length === 0 && sections[k].length > 0) this.folded.delete(k);
        this.sections = sections;
        this.error = null;
        this.loading = false;
        cx.notify();
        await this.fetchAvatars([...nodes, ...merged], cx);
      } catch (e) {
        this.error = String(e.message ?? e);
        this.loading = false;
      } finally {
        // At least one full turn, so a quick refresh still shows it happened.
        const left = SPIN_MS - (Date.now() - started);
        if (left > 0) await cx.sleep(left);
        this.busy = false;
      }
      cx.notify();
    });
  }

  // Avatars go through curl into the mod's own folder; a miss shows an initial.
  async fetchAvatars(nodes, cx) {
    const dir = `${appHome()}/${AVATARS}`;
    try { await mkdir(dir, { recursive: true }); } catch {}
    let changed = false;
    for (const pr of nodes) {
      const login = pr.author?.login, url = pr.author?.avatarUrl;
      if (!login || login in this.avatars) continue;
      const file = `${dir}/${login}.png`;
      try {
        if (!(await exists(file))) {
          if (!url) throw new Error("no url");
          const sep = url.includes("?") ? "&" : "?";
          const r = await exec("curl", ["-fsSL", "--max-time", "10", `${url}${sep}s=64`, "-o", file]);
          if (r.code !== 0) throw new Error(r.stderr);
        }
        this.avatars[login] = true;
      } catch {
        this.avatars[login] = false;
      }
      changed = true;
    }
    if (changed) cx.notify();
  }

  avatar(t, login) {
    if (login && this.avatars[login]) return image(`${AVATARS}/${login}.png`).size(18).flex_none().rounded_full();
    return div().size(18).flex_none().rounded_full().bg(t.raised).border(1).border_color(t.border).flex().items_center().justify_center()
      .text_size(9.5).font_semibold().text_color(t.muted).child((login ?? "?")[0].toUpperCase());
  }

  ci(t, pr) {
    const s = ciState(pr);
    if (s === "SUCCESS") return svg("mods/workspace-chrome/check.svg").size(13).flex_none().text_color(t.done);
    if (s === "FAILURE" || s === "ERROR") return svg("mods/workspace-chrome/x.svg").size(13).flex_none().text_color(t.blocked);
    if (s === "PENDING" || s === "EXPECTED") return div().size(7).mx(3).flex_none().rounded_full().bg(t.dim).loop("opacity", { from: 0.35, to: 1, period: 1200 });
    return null;
  }

  row(t, pr) {
    const [word, tone] = statusWord(pr);
    const mark = pr.merged ? null : this.ci(t, pr);
    return v_flex()
      .id(`pr-${pr.repository.nameWithOwner}-${pr.number}`)
      .mx(8).px(10).py(6).gap(3).rounded(3).flex_none().cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => { exec("open", [pr.url]); })
      .child(h_flex().gap(8).items_center()
        .child(svg(`mods/prs/gh-${prState(pr)}.svg`).size(14).flex_none().text_color(iconColor(t, pr)))
        .child(div().flex_1().min_w(0).truncate().text_size(12.8).text_color(t.foreground).child(pr.title))
        .when(Boolean(mark), (el) => el.child(mark))
        .child(this.avatar(t, pr.author?.login)))
      .child(h_flex().pl(21).gap(6).items_center().text_size(11.5)
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`${pr.repository.name} · #${pr.number} · ${age(pr.merged ? pr.mergedAt : pr.updatedAt)}`))
        .child(div().flex_none().text_color(t[tone] ?? t.muted).child(word)));
  }

  header(t, key, label, count) {
    const open = !this.folded.has(key);
    return h_flex()
      .id(`sec-${key}`)
      .h(30).px(18).gap(7).items_center().flex_none().cursor_pointer()
      .bg("#ffffff06") // white ~2.5%: a faint band over the panel
      .text_color(count ? t.foreground : t.muted)
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { open ? this.folded.add(key) : this.folded.delete(key); cx.notify(); })
      .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none())
      .child(div().text_size(13).font_medium().child(label))
      .child(div().text_size(12).text_color(t.muted).child(String(count)));
  }

  render() {
    const t = theme();
    const sections = this.sections ?? {};
    const total = SECTIONS.reduce((n, [k]) => n + (k === "mergedToday" ? 0 : sections[k]?.length ?? 0), 0);
    const pill = (text) => div().h(20).px(7).rounded(2).border(1).border_color(t.border).flex().items_center().text_size(10.5).text_color(t.muted).child(text);
    const body = [];
    for (const [key, label] of SECTIONS) {
      const list = sections[key] ?? [];
      body.push(header(this, t, key, label, list.length));
      if (!this.folded.has(key)) for (const pr of list) body.push(this.row(t, pr));
    }
    return v_flex()
      .size_full().min_h(0)
      .overflow_hidden().bg(t.background)
      .text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().text_color(t.foreground).child("Pull requests"))
        .when(this.sections !== null, (el) => el.child(pill(`${total} open · last 30d`)))
        .child(div().flex_1())
        .child(div().text_size(11.5).text_color(t.dim).child("github.com"))
        .child(div().id("pr-refresh").size(24).flex_none().flex().items_center().justify_center().rounded(2).text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.refresh(cx))
          .child(this.busy ? svg("mods/prs/refresh.svg").size(13).spin(SPIN_MS) : svg("mods/prs/refresh.svg").size(13))))
      .when(Boolean(this.error), (el) => el.child(div().px(14).py(6).text_size(11.5).text_color(t.blocked).border_b(1).border_color(t.border).child(this.error)))
      .when(this.loading && this.sections === null, (el) => el.child(div().px(14).py(10).text_size(12).text_color(t.dim).child("Loading…")))
      .when(this.sections !== null, (el) => el.child(v_flex().id("pr-list").flex_1().min_h(0).overflow_y_scrollbar().children(body)));
  }
}

const header = (view, t, key, label, count) => view.header(t, key, label, count);
