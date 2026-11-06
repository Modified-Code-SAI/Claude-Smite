import type { Combatant } from './combatant';
import { normalizeLoadout, ULTIMATE_SLOT } from './loadout';
import { indexTrees, pointsInTree, treeOrder, type Allocation } from './trees';
import type { GodDef } from './types';

/**
 * Saved builds: a god's skills on the bar and where its tree points go,
 * kept between sessions. Each god comes with one ready-made build per
 * playstyle tree, and a player can save up to MAX_SAVED of their own.
 * Following a build spends new points along it as they are earned.
 */
export interface Build {
  /** `tree:<index>` for a ready-made build, `mine:<n>` for a saved one. */
  id: string;
  name: string;
  loadout: readonly string[];
  /** The ranks the build aims for, learned first (empty for a ready-made build). */
  ranks: Allocation;
  /** Trees in the order the rest of the points go: up each to its keystone. */
  trees: readonly number[];
}

/** What is kept per god. */
export interface GodBuilds {
  saved: Build[];
  /** The build in use, or null for spending points by hand. */
  active: string | null;
  /** The skills last on the bar, put back at the start of the next match. */
  bar: string[] | null;
}

export const MAX_SAVED = 4;
const KEY = 'ascendant.builds';

const ready = new WeakMap<GodDef, readonly Build[]>();

/**
 * One build per playstyle tree: the skills it changes on the bar, straight up
 * the tree to its keystone, then up the next one. Made once per god (the
 * build in use is looked up every frame).
 */
export function readyBuilds(god: GodDef): readonly Build[] {
  let out = ready.get(god);
  if (!out) ready.set(god, (out = god.trees.map((t, i) => ({ id: `tree:${i}`, name: t.name, loadout: treeLoadout(god, i), ranks: {}, trees: [i, (i + 1) % god.trees.length] }))));
  return out;
}

/**
 * The bar a tree plays best with: the god's own, with the skills its
 * talents change swapped in for ones it leaves alone (a keystone's skill
 * counts most), each staying in its usual slot where it can.
 */
export function treeLoadout(god: GodDef, index: number): readonly string[] {
  const tree = god.trees[index];
  const bar = [...god.defaultLoadout];
  if (!tree) return bar;
  const weight = new Map<string, number>();
  for (const n of tree.nodes) {
    for (const e of n.effects) if (e.type === 'skill' || e.type === 'augment') weight.set(e.skill, (weight.get(e.skill) ?? 0) + (n.tier === 4 ? 3 : 1));
  }
  const w = (id: string | undefined) => (id ? (weight.get(id) ?? 0) : 0);
  const wanted = god.skills.filter((s) => w(s.id) > 0).sort((a, b) => w(b.id) - w(a.id));
  const ult = wanted.find((s) => s.kind === 'ultimate');
  if (ult) bar[ULTIMATE_SLOT] = ult.id;
  for (const s of wanted) {
    if (s.kind !== 'regular' || bar.includes(s.id)) continue;
    // the regular slot whose skill the tree cares least about
    let slot = -1;
    for (let k = 0; k < ULTIMATE_SLOT; k++) if (w(bar[k]) < w(s.id) && (slot < 0 || w(bar[k]) < w(bar[slot]))) slot = k;
    if (slot >= 0) bar[slot] = s.id;
  }
  return normalizeLoadout(god, bar);
}

/**
 * The order points go in a build: its own ranks tree by tree from the bottom,
 * then the rest of its trees, the first one to its keystone. A keystone is
 * tried before the rest of its tree, so it is learned the moment it opens.
 */
export function spendOrder(god: GodDef, b: Build): { id: string; cap: number }[] {
  const out: { id: string; cap: number }[] = [];
  const trees = [...b.trees, ...god.trees.map((_, i) => i).filter((i) => !b.trees.includes(i))];
  const upTree = (i: number, key: boolean): string[] => {
    const tree = god.trees[i];
    if (!tree) return [];
    const k = key ? tree.nodes.find((n) => n.tier === 4) : undefined;
    return k ? [k.id, ...treeOrder(tree, false)] : treeOrder(tree, false);
  };
  for (const i of trees) for (const id of upTree(i, true)) if (b.ranks[id]) out.push({ id, cap: b.ranks[id]! });
  // what the build didn't say goes up its trees in order, the first one to its keystone
  for (const [k, i] of trees.entries()) for (const id of upTree(i, k === 0)) out.push({ id, cap: Infinity });
  return out;
}

/** The ready-made build whose bar shares the most skills with `bar` (the god's first tree on a tie). */
export function fittingBuild(god: GodDef, bar: readonly string[]): Build {
  const all = readyBuilds(god);
  let best = all[0]!;
  let most = -1;
  for (const b of all) {
    const n = b.loadout.filter((id) => bar.includes(id)).length;
    if (n > most) [best, most] = [b, n];
  }
  return best;
}

/** The toast for a match's starting points spent up a tree for the player. */
export function startingPointsLine(s: { tree: string; points: number }): string {
  return `Your ${s.points} skill point${s.points === 1 ? '' : 's'} went into ${s.tree}. Press K to spend them your own way.`;
}

/** Spend every free point along a build: true when any point went in. */
export function spendAlong(c: Combatant, b: Build): boolean {
  const order = spendOrder(c.god, b);
  let spent = false;
  while (c.unspentPoints > 0 && order.some(({ id, cap }) => (c.allocation[id] ?? 0) < cap && c.allocate(id) === null)) spent = true;
  return spent;
}

/**
 * Take a build at the fountain: its skills on the bar (when `skills`), every
 * point refunded and spent again along it. Away from the fountain only new
 * points follow it ('field'), and the rest waits for the next visit.
 */
export function applyBuild(c: Combatant, b: Build, skills = true): 'field' | null {
  if (!c.inBase) {
    spendAlong(c, b);
    return 'field';
  }
  c.setBuild(skills ? normalizeLoadout(c.god, b.loadout) : c.loadout, {});
  spendAlong(c, b);
  return null;
}

/** A build of what the god has now: its bar, its ranks, and its trees by points spent. */
export function snapshotBuild(c: Combatant, id: string, name: string): Build {
  const index = indexTrees(c.god);
  const trees = c.god.trees
    .map((t, i) => ({ i, pts: pointsInTree(index, c.allocation, t.id) }))
    .filter((t) => t.pts > 0)
    .sort((a, b) => b.pts - a.pts)
    .map((t) => t.i);
  const ranks: Record<string, number> = {};
  for (const [nid, r] of Object.entries(c.allocation)) if (r > 0 && index.node.has(nid)) ranks[nid] = r;
  return { id, name, loadout: [...c.loadout], ranks, trees: trees.length ? trees : [0, 1] };
}

/** A new saved build's name: "My Stormcaller", then "My Stormcaller 2". */
export function nameFor(god: GodDef, b: Build, taken: readonly Build[]): string {
  const base = `My ${god.trees[b.trees[0] ?? 0]?.name ?? 'build'}`;
  let name = base;
  for (let n = 2; taken.some((t) => t.name === name); n++) name = `${base} ${n}`;
  return name;
}

/** Every god's saved builds, read from local storage (empty when it is unavailable). */
export function loadBuilds(): Record<string, GodBuilds> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Partial<GodBuilds>>;
    const out: Record<string, GodBuilds> = {};
    for (const [god, v] of Object.entries(raw)) {
      // names are shown as markup, so nothing that reads as a tag survives a hand-edited store
      const saved = Array.isArray(v.saved) ? v.saved.filter(isBuild).slice(0, MAX_SAVED).map((b) => ({ ...b, name: b.name.replace(/[<>&"']/g, '').slice(0, 40) || 'My build' })) : [];
      const bar = Array.isArray(v.bar) && v.bar.every((x) => typeof x === 'string') ? v.bar : null;
      out[god] = { saved, active: typeof v.active === 'string' ? v.active : null, bar };
    }
    return out;
  } catch {
    return {};
  }
}

export function saveBuilds(all: Record<string, GodBuilds>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable: builds last this session only */
  }
}

function isBuild(b: unknown): b is Build {
  const x = b as Build;
  return !!x && typeof x.id === 'string' && typeof x.name === 'string' && Array.isArray(x.loadout) && typeof x.ranks === 'object' && x.ranks !== null && Array.isArray(x.trees);
}

/**
 * The god pick screen's build choice: the build to follow from the first
 * point (null: spend by hand), its skills on the bar the match starts with.
 */
export function chooseBuild(god: GodDef, id: string | null): void {
  const all = loadBuilds();
  const g = (all[god.id] ??= { saved: [], active: null, bar: null });
  const b = id ? [...readyBuilds(god), ...g.saved].find((x) => x.id === id) : null;
  g.active = b?.id ?? null;
  if (b) g.bar = [...b.loadout];
  saveBuilds(all);
}

/** A god's builds and the one in use, read fresh (the pick screen, before any match exists). */
export function buildChoice(god: GodDef): { list: Build[]; active: string | null } {
  const g = loadBuilds()[god.id];
  const list = [...readyBuilds(god), ...(g?.saved ?? [])];
  return { list, active: list.some((b) => b.id === g?.active) ? g!.active : null };
}

/** The skills a god's next match starts with: last time's bar, or the god's own. */
export function startingBar(god: GodDef): readonly string[] {
  const bar = loadBuilds()[god.id]?.bar;
  return bar ? normalizeLoadout(god, bar) : god.defaultLoadout;
}

/** What a mode lets a build do. */
export interface BuildRules {
  /** Set the skills on the bar (not where the mode deals the skills, like Underworld Descent's drafts). */
  skills: boolean;
  /** Spend new points (not where a mode adds a tree of its own to spend by hand, like Relic Rush's Playmaker). */
  follow: boolean;
}

/**
 * The local player's builds for one god at a time: which is in use, saving
 * and deleting their own, and following the one in use as points come in.
 */
export class BuildBook {
  private readonly all = loadBuilds();
  /** A build picked away from the fountain, set up in full on the next visit. */
  private pending: string | null = null;

  constructor(readonly rules: BuildRules = { skills: true, follow: true }) {}

  /** Ready-made and saved builds for a god, ready-made first. */
  list(god: GodDef): Build[] {
    return [...readyBuilds(god), ...this.of(god).saved];
  }

  active(god: GodDef): Build | null {
    const id = this.of(god).active;
    return this.list(god).find((b) => b.id === id) ?? null;
  }

  /** Whether the build in use is still waiting for the fountain to be set up in full. */
  waiting(god: GodDef): boolean {
    return this.pending !== null && this.pending === `${god.id}/${this.of(god).active}`;
  }

  /** Use a build (null: spend by hand from now on). 'field' when the rest waits for the fountain. */
  use(c: Combatant, id: string | null): 'field' | null {
    const g = this.of(c.god);
    g.active = id;
    this.pending = null;
    saveBuilds(this.all);
    const b = this.active(c.god);
    if (!b) return null;
    if (!this.rules.follow) return null;
    const r = applyBuild(c, b, this.rules.skills);
    if (r) this.pending = `${c.god.id}/${b.id}`;
    else if (this.rules.skills) this.rememberBar(c);
    return r;
  }

  /** Whether the god has room for another saved build. */
  canSave(god: GodDef): boolean {
    return this.of(god).saved.length < MAX_SAVED;
  }

  /** Save what the god has now as a new build, and use it. Null when the god already has MAX_SAVED. */
  save(c: Combatant): Build | null {
    const g = this.of(c.god);
    if (g.saved.length >= MAX_SAVED) return null;
    let n = 1;
    while (g.saved.some((b) => b.id === `mine:${n}`)) n++;
    const b = snapshotBuild(c, `mine:${n}`, '');
    b.name = nameFor(c.god, b, g.saved);
    g.saved.push(b);
    g.active = b.id;
    this.pending = null;
    saveBuilds(this.all);
    return b;
  }

  remove(god: GodDef, id: string): void {
    const g = this.of(god);
    g.saved = g.saved.filter((b) => b.id !== id);
    if (g.active === id) g.active = null;
    saveBuilds(this.all);
  }

  /** Remember the skills on the god's bar for next time. */
  rememberBar(c: Combatant): void {
    if (!this.rules.skills) return;
    const g = this.of(c.god);
    if (g.bar && g.bar.join() === c.loadout.join()) return;
    g.bar = [...c.loadout];
    saveBuilds(this.all);
  }

  /** Put back the skills the god had on its bar last time (at the start of a match, at the fountain). */
  restoreBar(c: Combatant): void {
    const bar = this.of(c.god).bar;
    if (bar && this.rules.skills) c.setBuild(normalizeLoadout(c.god, bar), c.allocation);
  }

  /**
   * Spend new points along the build in use ('spent'), or set it up in full
   * when the god reaches the fountain after picking it in the field ('setup').
   */
  follow(c: Combatant): 'spent' | 'setup' | null {
    if (!this.rules.follow) return null;
    const b = this.active(c.god);
    if (!b) return null;
    if (this.waiting(c.god) && c.inBase) {
      this.pending = null;
      applyBuild(c, b, this.rules.skills);
      this.rememberBar(c);
      return 'setup';
    }
    return c.unspentPoints > 0 && spendAlong(c, b) ? 'spent' : null;
  }

  private of(god: GodDef): GodBuilds {
    return (this.all[god.id] ??= { saved: [], active: null, bar: null });
  }
}
