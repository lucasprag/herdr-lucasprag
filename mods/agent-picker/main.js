// Start an agent with a model, in a new tab of the current space. Opens with cmd-shift-t
// (keys.json: mod.open:agent-picker). Type to filter ("opus", "codex astra"), ↑/↓ and Enter
// to start, Esc to leave. Agents come from knownAgents() (programs.json's run commands);
// MODELS adds one row per model for the agents listed there, after a plain row (its default).
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { knownAgents, spaces, run, theme, props, closeOverlay, shared, setShared } from "herdr";


// Per agent key (as knownAgents() reports it): the models to offer and the argv to add.
const MODELS = {
  claude: [
    { label: "Fable", args: ["--model", "fable"] },
    { label: "Opus", args: ["--model", "opus"] },
    // --advisor: Claude Code's server-side advisor tool; Opus consults Fable on hard calls.
    { label: "Opus + Fable advisor", args: ["--model", "opus", "--advisor", "fable"] },
    { label: "Sonnet", args: ["--model", "sonnet"] },
    { label: "Haiku", args: ["--model", "haiku"] },
  ],
  codex: [
    { label: "Astra", args: ["-m", "gpt-6-astra"] },
    { label: "Sol", args: ["-m", "gpt-6.1-sol"] },
    { label: "Terra", args: ["-m", "gpt-6.1-terra"] },
  ],
};
const KNOWN = "new-menu.agents"; // the + menu's cache of knownAgents(), shared so both open instantly
const ROW = 32;
const LIST_MAX = 400;

export default class AgentPicker extends View {
  init(_props, cx) {
    this.filter = "";
    this.at = 0;
    this.scroll = 0;
    const machine = spaces().find((s) => s.active)?.machine;
    const where = machine ?? "";
    this.agents = shared(KNOWN)?.[where] ?? [];
    this.input = InputState.new({ placeholder: "Start an agent… (claude opus, codex astra)" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); this.at = 0; this.scroll = 0; cx.notify(); });
    this.input.on("submit", () => this.go(this.rows()[this.at]));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      try {
        this.agents = await knownAgents({ on: machine });
        setShared(KNOWN, { ...shared(KNOWN), [where]: this.agents });
      } catch {
        this.failed = true;
      }
      cx.notify();
    });
  }

  close() { closeOverlay(props().overlay); }

  rows() {
    const words = this.filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    for (const a of this.agents.filter((a) => a.installed)) {
      out.push({ agent: a, label: a.name, argv: a.run, name: a.name });
      for (const m of MODELS[a.key] ?? []) {
        out.push({ agent: a, label: `${a.name} · ${m.label}`, model: m.label, argv: [...a.run, ...m.args], name: m.label });
      }
    }
    return out.filter((r) => words.every((w) => r.label.toLowerCase().includes(w)));
  }

  go(r) {
    if (!r) return;
    this.close();
    // No name: the tab stays unnamed so the tab bar (lucasprag-tabs) labels it with what the agent is doing.
    run("tab.new", { space: spaces().find((s) => s.active)?.id, argv: r.argv });
  }

  icon(t, a) {
    return a.tint ? svg(a.icon).size(14).flex_none().text_color(t.foreground) : image(a.icon).size(14).flex_none();
  }

  render() {
    const t = theme();
    const rows = this.rows();
    this.at = Math.max(0, Math.min(this.at, Math.max(0, rows.length - 1)));
    const total = rows.length * ROW;
    const height = Math.min(LIST_MAX, Math.max(ROW, total));
    const fixed = total > height;
    const maxScroll = Math.max(0, total - height);
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
    const top = this.at * ROW;
    if (top < this.scroll) this.scroll = top;
    if (top + ROW > this.scroll + height) this.scroll = top + ROW - height;
    const visible = (i) => !fixed || (i * ROW + ROW > this.scroll && i * ROW < this.scroll + height);
    const place = (el, i) => fixed ? el.absolute().left(0).right(0).top(i * ROW - this.scroll).h(ROW) : el;

    const row = (r, i) => {
      const on = i === this.at;
      return h_flex()
        .id(`ap-${r.agent.key}-${r.model ?? "default"}`)
        .px(10).h(ROW).items_center().gap(10).rounded(3)
        .cursor_pointer()
        .when(on, (el) => el.bg(t.hover))
        .hover((s) => s.bg(t.hover))
        .on_click(() => this.go(r))
        .child(this.icon(t, r.agent))
        .child(h_flex().flex_1().min_w(0).gap(6)
          .child(div().text_color(r.model ? t.muted : t.foreground).child(r.agent.name))
          .when(Boolean(r.model), (el) => el.child(div().text_color(t.dim).child("·")).child(div().text_color(t.foreground).font_medium().child(r.model))))
        .when(!r.model, (el) => el.child(div().text_size(11).text_color(t.dim).child("default model")));
    };

    const empty = this.agents.length === 0
      ? (this.failed ? "Could not load agents" : "Checking installed agents…")
      : rows.length === 0 ? "No match" : null;

    return v_flex()
      .id("agent-picker")
      .track_focus(this.handle)
      .size_full().min_h(0).pt(18).gap(10).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") return this.close();
        if (!rows.length) return;
        if (k === "down") this.at = (this.at + 1) % rows.length;
        else if (k === "up") this.at = (this.at + rows.length - 1) % rows.length;
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().px(18).items_center()
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("New agent tab"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(h_flex().mx(18).h(36).flex_none().px(10).gap(8).items_center().rounded(4).border_1().border_color(t.accent).bg(t.background)
        .child(svg("mods/workspace-chrome/search.svg").size(15).text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)))
      .child(v_flex().id("ap-list").mx(18).h(height).min_h(0).mb(6)
        .when(Boolean(empty), (el) => el.child(div().px(10).py(8).text_color(t.dim).child(empty)))
        .when(fixed, (el) => el.overflow_hidden().on_scroll_wheel((e, cx) => {
          this.scroll = Math.max(0, Math.min(this.scroll - e.delta.y, maxScroll));
          while (this.at < rows.length - 1 && this.at * ROW < this.scroll) this.at++;
          while (this.at > 0 && this.at * ROW + ROW > this.scroll + height) this.at--;
          cx.notify();
        }))
        .children(rows.map((r, i) => (visible(i) ? place(row(r, i), i) : null)).filter(Boolean)));
  }
}
