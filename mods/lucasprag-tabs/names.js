// Names each tab after what's in it: an agent tab after the title its agent sets
// (Claude Code: the conversation title), a terminal tab after its running program,
// or its folder at the prompt. Leaves a tab alone once you rename it yourself.
// Adapted from longwave/herdr-auto-tabs (names.js).

import { spaces, panes, shared, setShared, run } from "herdr";

const KEY = "tab-titles.set"; // tab id -> the name we gave it

// Names that aren't yours: Herdr's own ids, and the names the + menu and
// agent-picker give new agent tabs ("Claude Code").
function isDefault(name, program) {
  if (/^tb\d+$/.test(name)) return true;
  const agents = Object.values(shared("new-menu.agents") ?? {}).flat().map(a => a?.name);
  return [program?.name, "Claude Code", ...agents].filter(Boolean)
    .some(n => n.toLowerCase() === name.toLowerCase());
}

function nameFor(p) {
  if (p.program?.agent) {
    // Agents prefix a spinner or ✳ while working; a title equal to the agent's name says nothing.
    const title = (p.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
    return title && title.toLowerCase() !== p.program.name?.toLowerCase() ? title : p.program.name;
  }
  if (!p.program?.shell) return p.program?.name;
  if (!p.cwd) return null;
  return p.cwd === homeOf(p.cwd) ? "~" : p.cwd.split("/").filter(Boolean).pop();
}

function homeOf(cwd) {
  return cwd.match(/^\/(?:Users|home)\/[^/]+|^\/root/)?.[0];
}

export function syncNames() {
  const saved = shared(KEY) ?? {};
  const ours = { ...saved };
  const tabs = new Map(spaces().flatMap(s => s.tabs).map(t => [t.id, t]));
  // One pane per tab: its agent pane if it has one, else its first terminal.
  const pick = new Map();
  for (const p of panes()) {
    if (!p.terminal) continue;
    const cur = pick.get(p.tab);
    if (!cur || (p.program?.agent && !cur.program?.agent)) pick.set(p.tab, p);
  }
  for (const [id, p] of pick) {
    const tab = tabs.get(id);
    const name = nameFor(p);
    if (!tab || !name || tab.name === name) continue;
    if (tab.named && ours[tab.id] !== tab.name && !isDefault(tab.name, p.program)) continue;
    run("tab.rename", { id: tab.id, name });
    ours[tab.id] = name;
  }
  for (const id of Object.keys(ours)) if (!tabs.has(id)) delete ours[id];
  if (JSON.stringify(ours) !== JSON.stringify(saved)) setShared(KEY, ours);
}
