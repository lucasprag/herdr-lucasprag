// New space: a name (optional) and a folder. Opens with cmd-n (keys.json: mod.open:new-space).
// The folder list is ~/Projects, then recently used, then the subfolders of ~/Projects;
// typing in the Folder field filters, and also searches ~/.herdr/worktrees.
// Tab: next field. Enter: create a new space (always, even if one shows that folder). Esc: leave.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { readdir } from "fs/promises";
import { spaces, panes, run, theme, props, closeOverlay, home } from "herdr";


const HOME = home();
const ROOT = `${HOME}/Projects`;
// Folders searched when the filter is non-empty: their children are candidates.
// Folders listed without a filter: their children are candidates.
const LIST_ROOTS = [ROOT];
const WORKTREES = `${HOME}/.herdr/worktrees`;
const RECENTS_MAX = 5;
const ROW = 32;
const LIST_MAX = 320;

const tilde = (p) => (p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p);
const expand = (p) => (p.startsWith("~") ? HOME + p.slice(1) : p);
const trimSlash = (p) => p.replace(/\/+$/, "") || "/";

async function subfolders(dir) {
  const out = [];
  try {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith(".")) out.push(`${dir}/${e.name}`);
    }
  } catch {}
  return out.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

export default class NewSpace extends View {
  init(_props, cx) {
    this.filter = "";
    this.at = 0;
    this.scroll = 0;
    this.base = []; // subfolders of LIST_ROOTS
    this.extra = []; // the wider search, loaded once a filter is typed
    this.loadingExtra = false;
    this.recents = JSON.parse(localStorage.getItem("recents") ?? "[]");
    this.focusedField = "name";

    this.name = InputState.new({ placeholder: "Space name (optional)" });
    this.folder = InputState.new({ placeholder: "Folder in ~/Projects (empty: ~/Projects)" });
    this.name.on("focus", (_e, cx) => { this.focusedField = "name"; cx.notify(); });
    this.folder.on("focus", (_e, cx) => { this.focusedField = "folder"; cx.notify(); });
    this.name.on("submit", () => this.go());
    this.folder.on("submit", () => this.go());
    this.folder.on("change", (_e, cx) => {
      this.filter = this.folder.value();
      this.at = 0; this.scroll = 0;
      if (this.filter.trim() && !this.extraLoaded && !this.loadingExtra) this.loadExtra(cx);
      cx.notify();
    });
    this.name.focus();
    cx.timer.after(600, () => this.name.focus());
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      const found = [];
      for (const r of LIST_ROOTS) found.push(...await subfolders(r));
      this.base = found;
      cx.notify();
    });
  }

  loadExtra(cx) {
    this.loadingExtra = true;
    cx.spawn(async (cx) => {
      const found = [];
      for (const repo of await subfolders(WORKTREES)) found.push(...await subfolders(repo));
      this.extra = [...new Set(found)];
      this.extraLoaded = true;
      this.loadingExtra = false;
      cx.notify();
    });
  }

  close() { closeOverlay(props().overlay); }

  // Where each local space is now: its first terminal's live folder, else where it was made.
  openSpaces() {
    const ps = panes();
    const out = new Map();
    for (const s of spaces()) {
      if (s.machine) continue;
      const tabs = new Set(s.tabs.map((t) => t.id));
      const cwd = ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
      if (cwd) out.set(trimSlash(cwd), s);
    }
    return out;
  }

  rows() {
    const f = this.filter.trim().toLowerCase();
    const open = this.openSpaces();
    let folders;
    if (!f) {
      const recents = this.recents.filter((r) => r !== ROOT).slice(0, RECENTS_MAX);
      folders = [ROOT, ...recents, ...this.base];
    } else {
      folders = [ROOT, ...this.recents, ...this.base, ...this.extra].filter((p) => tilde(p).toLowerCase().includes(f));
    }
    const seen = new Set();
    return folders.filter((p) => !seen.has(p) && seen.add(p)).map((folder) => ({
      // Children of ~/Projects go by their bare name, as the list's hint says where they are.
      folder, label: folder.startsWith(ROOT + "/") && !folder.slice(ROOT.length + 1).includes("/") ? folder.slice(ROOT.length + 1) : tilde(folder),
      recent: this.recents.includes(folder), space: open.get(trimSlash(folder)),
    }));
  }

  go(row = this.rows()[this.at]) {
    const typed = this.filter.trim();
    let folder = row?.folder;
    if (!folder) folder = typed ? trimSlash(expand(typed)) : ROOT;
    this.close();
    this.recents = [folder, ...this.recents.filter((r) => r !== folder)].slice(0, 20);
    localStorage.setItem("recents", JSON.stringify(this.recents));
    const name = this.name.value().trim();
    run("space.new", { ...(name ? { name } : {}), folder, machine: "" });
  }

  field(t, id, label, state, focused) {
    return v_flex().mx(18).gap(6)
      .child(div().text_size(11.5).text_color(t.dim).child(label))
      .child(h_flex().id(id).h(36).flex_none().px(12).items_center().rounded(4).border_1()
        .border_color(focused ? t.accent : t.input).bg(t.background)
        .on_click(() => state.focus())
        .child(Input.new(state).flex_1().h_full().text_size(12.8).text_color(t.foreground)));
  }

  render() {
    const t = theme();
    const rows = this.rows();
    this.at = Math.max(0, Math.min(this.at, Math.max(0, rows.length - 1)));
    const total = rows.length * ROW;
    const height = Math.min(LIST_MAX, total);
    const fixed = total > height;
    const maxScroll = Math.max(0, total - height);
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
    const top = this.at * ROW;
    if (top < this.scroll) this.scroll = top;
    if (top + ROW > this.scroll + height) this.scroll = top + ROW - height;
    const visible = (i) => !fixed || (i * ROW + ROW > this.scroll && i * ROW < this.scroll + height);
    const place = (el, i) => (fixed ? el.absolute().left(0).right(0).top(i * ROW - this.scroll).h(ROW) : el);

    const row = (r, i) => {
      const on = i === this.at;
      return h_flex()
        .id(`ns-${r.folder}`)
        .px(10).h(ROW).items_center().gap(10).rounded(3)
        .cursor_pointer()
        .when(on, (el) => el.bg(t.hover))
        .hover((s) => s.bg(t.hover))
        .on_click(() => this.go(r))
        .child(svg("mods/workspace-chrome/folder.svg").size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().text_color(r.folder === ROOT ? t.muted : t.foreground).child(r.label))
        .when(r.recent && r.folder !== ROOT, (el) => el.child(div().text_size(11).text_color(t.dim).child("recent")))
        .when(Boolean(r.space), (el) => el.child(div().text_size(11).text_color(t.done).child("open")));
    };

    return v_flex()
      .id("new-space")
      .track_focus(this.handle)
      .w_full().min_h(0).pt(18).pb(6).gap(12).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") return this.close();
        if (k === "tab") { (this.focusedField === "name" ? this.folder : this.name).focus(); }
        else if (k === "down" && rows.length) this.at = (this.at + 1) % rows.length;
        else if (k === "up" && rows.length) this.at = (this.at + rows.length - 1) % rows.length;
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().px(18).items_center()
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("New space"))
        .child(div().text_size(11).text_color(t.dim).child("Tab: next field · Enter: create · Esc")))
      .child(this.field(t, "ns-name", "Name", this.name, this.focusedField === "name"))
      .child(this.field(t, "ns-folder", "Folder", this.folder, this.focusedField === "folder"))
      .child(div().px(20).text_size(11.5).text_color(t.dim).child("Recently used, then ~/Projects · typing also searches worktrees"))
      .when(rows.length === 0, (el) => el.child(div().px(28).py(4).text_size(12).text_color(t.dim).child(this.loadingExtra ? "Searching…" : "No folder matches; Enter uses what you typed")))
      .child(v_flex().id("ns-list").mx(18).h(height).min_h(0)
        .when(fixed, (el) => el.overflow_hidden().on_scroll_wheel((e, cx) => {
          this.scroll = Math.max(0, Math.min(this.scroll - e.delta.y, maxScroll));
          while (this.at < rows.length - 1 && this.at * ROW < this.scroll) this.at++;
          while (this.at > 0 && this.at * ROW + ROW > this.scroll + height) this.at--;
          cx.notify();
        }))
        .children(rows.map((r, i) => (visible(i) ? place(row(r, i), i) : null)).filter(Boolean)));
  }
}
