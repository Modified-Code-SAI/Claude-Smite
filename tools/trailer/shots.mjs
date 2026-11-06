// The trailer's in-game shots, filmed by film.mjs. `setup(stage, game)` and
// `director(dt, t, stage)` run inside the game page (src/dev/Stage.ts), so
// they are written as plain functions: the shared parts are spliced in as source.

/**
 * A god on the temple plaza unleashing its ultimate, then a skill, on an enemy
 * god, the camera swinging from behind the hero's shoulder round to its side.
 */
function hero(god, foe, opts = {}) {
  const cfg = JSON.stringify({ god, foe, slots: opts.slots ?? [[0.15, 3], [1.25, 0]], a0: opts.a0 ?? 1.2, a1: opts.a1 ?? 1.6 });
  return {
    url: `map=arena&god=${god}&quality=high`,
    frames: opts.frames ?? 66,
    setup: `(s, g) => {
      const cfg = ${cfg};
      s.clear();
      s.park(0, 44);
      const u = s.god(cfg.god, 'order', 0, 15, 0);
      const f = s.god(cfg.foe, 'chaos', 0, 9, Math.PI);
      u.brain = null;
      f.brain = null;
      Object.assign(s.vars, { hero: u, foe: f, cfg, gy: g.world.collision.groundAt(0, 12) });
      return { hero: u.name, foe: f.name, gy: s.vars.gy };
    }`,
    director: `(dt, t, s) => {
      const { hero, foe, cfg, gy } = s.vars;
      for (const [at, slot] of cfg.slots) if (t >= at && !s.vars['c' + at]) { s.vars['c' + at] = 1; s.cast(hero, slot, foe.x, foe.z); }
      const k = Math.min(1, t / 2.2);
      const e = k * k * (3 - 2 * k);
      const a = cfg.a0 + (cfg.a1 - cfg.a0) * e;
      const r = 6.6 - 0.9 * e;
      // aim between the two gods, following leaps and blinks without a jerk
      const mx = (hero.x + foe.x) / 2, mz = (hero.z + foe.z) / 2 + 1.2;
      if (!s.vars.m) s.vars.m = { x: mx, z: mz };
      const k2 = Math.min(1, dt * 3);
      s.vars.m.x += (mx - s.vars.m.x) * k2;
      s.vars.m.z += (mz - s.vars.m.z) * k2;
      const cx = s.vars.m.x, cz = s.vars.m.z;
      s.look(cx + Math.sin(a) * r, gy + 1.75 - 0.25 * e, cz + Math.cos(a) * r, cx, gy + 1.3, cz, 48);
    }`,
  };
}

/**
 * A Conquest moment found by skipping the bot match ahead until `find` (page
 * source returning the units to film, or null) has them, then circling them.
 * `cam`: radius, height, start angle, sweep (radians over the shot), fov.
 */
function conquest(find, opts = {}) {
  const cam = JSON.stringify({ r: 14, h: 7, a0: 0.6, sweep: 0.5, fov: 50, ...(opts.cam ?? {}) });
  return {
    url: opts.url ?? 'map=conquest&god=thor&quality=medium',
    frames: opts.frames ?? 60,
    setup: `(s, g) => {
      const find = ${find};
      const gods = () => s.combat.sim.units.filter((u) => u.kind === 'god' && u.alive && u !== s.combat.player);
      ${opts.park === false ? '' : 's.park(0, -150);'}
      ${opts.before ?? ''}
      s.vars.gy = (x, z) => g.world.collision.groundAt(x, z);
      s.vars.find = () => find(s.combat.sim.units.filter((u) => u.alive), gods());
      if (${opts.skip ?? 0}) s.skip(${opts.skip ?? 0});
      const ok = s.skipUntil(() => !!s.vars.find(), ${opts.limit ?? 600});
      const who = s.vars.find() ?? [];
      s.vars.cam = ${cam};
      s.vars.f = null;
      return { ok, at: s.skipped, who: who.map((u) => u.name + ' ' + Math.round(u.x) + ',' + Math.round(u.z)) };
    }`,
    director: `(dt, t, s) => {
      const c = s.vars.cam;
      const who = s.vars.find();
      if (who && who.length) {
        let x = 0, z = 0;
        for (const u of who) { x += u.x; z += u.z; }
        x /= who.length; z /= who.length;
        if (!s.vars.f) s.vars.f = { x, z };
        // ease toward the action so the camera never jerks
        const k = Math.min(1, dt * 1.5);
        s.vars.f.x += (x - s.vars.f.x) * k;
        s.vars.f.z += (z - s.vars.f.z) * k;
      }
      const f = s.vars.f;
      if (!f) return;
      const a = c.a0 + c.sweep * (t / 2.2);
      const cx = f.x + Math.sin(a) * c.r, cz = f.z + Math.cos(a) * c.r;
      const gy = s.vars.gy;
      s.look(cx, Math.max(gy(cx, cz) + 1.5, gy(f.x, f.z) + c.h), cz, f.x, gy(f.x, f.z) + 1.4, f.z, c.fov);
    }`,
  };
}

/** A fixed flight path (start and end camera and target) over the map a few seconds into the match. */
function flight(from, to, opts = {}) {
  const path = JSON.stringify({ from, to, fov: opts.fov ?? 50, dur: opts.dur ?? 2.2 });
  return {
    url: 'map=conquest&god=thor&quality=medium',
    frames: opts.frames ?? 66,
    setup: `(s, g) => {
      s.park(0, -150);
      s.skip(${opts.skip ?? 5});
      s.vars.p = ${path};
      s.vars.gy = (x, z) => g.world.collision.groundAt(x, z);
      return { at: s.skipped };
    }`,
    director: `(dt, t, s) => {
      const { from, to, fov, dur } = s.vars.p;
      const k = Math.min(1, t / dur);
      const e = k * k * (3 - 2 * k) * 0.6 + k * 0.4;
      const m = (i) => from[i] + (to[i] - from[i]) * e;
      s.look(m(0), m(1), m(2), m(3), m(4), m(5), fov);
    }`,
  };
}

function brawl(order, chaos, cam) {
  const teams = JSON.stringify({ order, chaos });
  return conquest(`(us, gods) => (gods.length >= 4 ? gods : null)`, {
    url: 'map=arena&god=zeus&quality=high',
    before: `s.clear();
      const T = ${teams};
      T.order.forEach((id, i) => s.god(id, 'order', (i - 1) * 3, 18, 0, { aggression: 0.9, leash: 40, aggro: 40 }));
      T.chaos.forEach((id, i) => s.god(id, 'chaos', (i - 1) * 3, 4, Math.PI, { aggression: 0.9, leash: 40, aggro: 40 }));`,
    skip: 1.2,
    limit: 5,
    frames: 75,
    cam: { r: 10, h: 3.2, sweep: 0.45, ...cam },
  });
}


/** A held key-art still in a mode (`?map=<map>`): `setup` stages it, `director` frames it. */
function still(map, setup, director) {
  return { url: `map=${map}&god=zeus&quality=high`, frames: 10, setup, director };
}

/** A fight in one of the other modes (`?map=<map>`), found and circled as in Conquest; the hidden player stays put. */
function mode(map, find, opts = {}) {
  return conquest(find, { url: `map=${map}&god=zeus&quality=medium`, park: false, frames: 40, ...opts });
}
/** Two enemy gods at blows. */
const duelFind = (range) => `(us, gods) => {
  for (const a of gods) for (const b of gods) if (a.team !== b.team && Math.hypot(a.x - b.x, a.z - b.z) < ${range}) return gods.filter((g) => Math.hypot(g.x - a.x, g.z - a.z) < ${range + 4});
  return null;
}`;
/** Gods on monsters. */
const monsterFind = `(us, gods) => {
  const m = us.find((u) => u.kind === 'monster' && gods.some((g) => Math.hypot(g.x - u.x, g.z - u.z) < 7));
  return m ? [m, ...gods.filter((g) => Math.hypot(g.x - m.x, g.z - m.z) < 9), ...us.filter((u) => u.kind === 'monster' && Math.hypot(u.x - m.x, u.z - m.z) < 6)] : null;
}`;

export const SHOTS = {
  // the other modes, a second of each for the montage
  mdClash: mode('clash', duelFind(6), { skip: 8, limit: 60, cam: { r: 10, h: 4.5, a0: 1.0, sweep: 0.35 } }),
  mdRush: mode('rush', `(us, gods) => (gods.filter((g) => Math.hypot(g.x, g.z) < 14).length >= 4 ? gods.filter((g) => Math.hypot(g.x, g.z) < 14) : null)`, { skip: 7, limit: 60, frames: 34, cam: { r: 12, h: 7.5, a0: -0.6, sweep: 0.3 } }),
  mdDescent: mode('descent', monsterFind, { skip: 6, limit: 60, cam: { r: 10, h: 5.5, a0: 2.2, sweep: 0.35 } }),
  mdJotunn: mode('jotunn', `(us, gods) => {
    const j = us.find((u) => u.name === 'Jötunn');
    const near = j ? gods.filter((g) => g !== j && Math.hypot(g.x - j.x, g.z - j.z) < 14) : [];
    return near.length >= 2 ? [j, j, j, ...near] : null;
  }`, { skip: 15, limit: 90, cam: { r: 20, h: 9, a0: 0.9, sweep: 0.3, fov: 55 } }),
  mdSiege: mode('siege', monsterFind, { skip: 25, limit: 90, frames: 34, cam: { r: 12, h: 9, a0: -1.4, sweep: 0.3 } }),
  // the home page's mode art (public/keyart, see the README): stills framed for a backdrop,
  // the subject right of center, where the menu's shade is lightest
  kaClash: still('clash', `(s, g) => {
      const p = s.combat.player;
      const gods = s.combat.sim.units.filter((u) => u.kind === 'god' && u !== p);
      const ally = gods.find((u) => u.team === p.team), foes = gods.filter((u) => u.team !== p.team);
      g.player.model.root.visible = true;
      s.skip(6);
      // the hill's two sides squaring up in front of its shrine, seen side-on
      s.combat.sim.teleport(p, -2.6, 6.2, -Math.PI / 2);
      if (ally) s.combat.sim.teleport(ally, -4.4, 7.8, -Math.PI / 2);
      if (foes[0]) s.combat.sim.teleport(foes[0], 2.4, 6.0, Math.PI / 2);
      if (foes[1]) s.combat.sim.teleport(foes[1], 4.2, 7.6, Math.PI / 2);
      s.vars.p = p; s.vars.all = [p, ally, ...foes].filter(Boolean);
      return { who: s.vars.all.map((u) => u.name) };
    }`, `(dt, t, s) => {
      const p = s.vars.p, f = s.vars.all.find((u) => u.team !== p.team);
      for (const u of s.vars.all) u.combatant.health = u.combatant.stats.maxHealth;
      if (!s.vars.cast && t > 0.02 && f) { s.vars.cast = 1; s.cast(p, 0, f.x, f.z); }
      s.look(0.6, 2.5, 13.4, 0, 1.5, 5.4, 50);
    }`),
  kaDuel: still('duel', `(s, g) => {
      const p = s.combat.player, r = s.combat.sim.units.find((u) => u.kind === 'god' && u.team === 'chaos');
      g.player.model.root.visible = true;
      // the ring holds 20 s then closes: run into the close with both duelists kept standing,
      // then bring the rival out from behind the shrine to face the player
      for (let i = 0; i < 64; i++) { s.skip(0.5); for (const u of [p, r]) u.combatant.health = u.combatant.stats.maxHealth; }
      s.combat.sim.teleport(p, 0, 13, 0);
      s.combat.sim.teleport(r, -1.4, 6.4, Math.PI);
      s.vars.p = p; s.vars.r = r;
      return { ring: s.combat.duel.ring, p: [p.x, p.z], r: [r.x, r.z] };
    }`, `(dt, t, s) => {
      const { p, r } = s.vars;
      for (const u of [p, r]) u.combatant.health = u.combatant.stats.maxHealth;
      if (!s.vars.cast && t > 0.02) { s.vars.cast = 1; s.cast(p, 0, r.x, r.z); }
      const dx = p.x - r.x, dz = p.z - r.z, d = Math.hypot(dx, dz) || 1;
      const bx = dx / d, bz = dz / d;
      const cx = p.x + bx * 4.2 - bz * 2.4, cz = p.z + bz * 4.2 + bx * 2.4;
      s.look(cx, 2.3, cz, (p.x + r.x) / 2 - bz * 1.2, 1.4, (p.z + r.z) / 2 + bx * 1.2, 46);
    }`),
  kaArena: still('arena', `(s, g) => {
      const p = s.combat.player;
      g.player.model.root.visible = true;
      // off the spawn dais, so its rim stays out of the foreground
      s.combat.sim.teleport(p, -1.4, 12.4, 0);
      s.vars.p = p;
      return { posts: s.combat.sim.units.filter((u) => u.kind === 'dummy').map((u) => [u.x, u.z]) };
    }`, `(dt, t, s) => {
      const p = s.vars.p;
      if (!s.vars.c1 && t > 0.02) { s.vars.c1 = 1; s.cast(p, 0, 0, 9); }
      s.look(2.3, 2.3, 16.4, -0.5, 1.4, 6, 46);
    }`),
  kaSiege: still('siege', `(s, g) => {
      const near = () => {
        const us = s.combat.sim.units.filter((u) => u.alive);
        const gods = us.filter((u) => u.kind === 'god' && u !== s.combat.player);
        const m = us.find((u) => u.kind === 'monster' && gods.some((x) => Math.hypot(x.x - u.x, x.z - u.z) < 6));
        return m ? [m, ...gods.filter((x) => Math.hypot(x.x - m.x, x.z - m.z) < 8)] : null;
      };
      s.park(0, 60);
      s.skip(28);
      const ok = s.skipUntil(() => !!near(), 90);
      s.vars.near = near;
      return { ok, at: s.skipped };
    }`, `(dt, t, s) => {
      const who = s.vars.near();
      if (who) { let x = 0, z = 0; for (const u of who) { x += u.x; z += u.z; } s.vars.f = { x: x / who.length, z: z / who.length }; }
      const f = s.vars.f;
      if (!f) return;
      // from the plaza's middle, looking out at the gate the fight is at
      const d = Math.hypot(f.x, f.z) || 1, ox = f.x / d, oz = f.z / d;
      s.look(f.x - ox * 10 + oz * 3, 6.5, f.z - oz * 10 - ox * 3, f.x + ox * 2, 1.2, f.z + oz * 2, 50);
    }`),
  kaJotunn: still('jotunn', `(s, g) => {
      const giant = () => s.combat.sim.units.find((u) => u.name === 'Jötunn');
      const gods = () => s.combat.sim.units.filter((u) => u.kind === 'god' && u.alive && u !== giant() && u !== s.combat.player);
      s.skip(12);
      const ok = s.skipUntil(() => { const j = giant(); return !!j && gods().filter((x) => Math.hypot(x.x - j.x, x.z - j.z) < 12).length >= 2; }, 90);
      // set the fight on the open plaza: the giant in the middle, two gods squaring up to it
      const j = giant(), two = gods().slice(0, 2);
      s.combat.sim.teleport(j, -0.5, -7, Math.PI);
      if (two[0]) s.combat.sim.teleport(two[0], 2.4, 1.2, 0);
      if (two[1]) s.combat.sim.teleport(two[1], -2.2, 2.2, 0);
      s.vars.giant = giant; s.vars.two = two;
      return { ok, at: s.skipped, gods: two.map((u) => u.name) };
    }`, `(dt, t, s) => {
      for (const u of s.vars.two) u.combatant.health = u.combatant.stats.maxHealth;
      // low behind the gods (inside the plaza's ring of columns), looking up at the giant over their heads
      s.look(3.6, 1.9, 9.6, -0.4, 8.4, -6, 68);
    }`),
  probeArena: {
    url: 'map=arena&god=zeus&quality=high',
    frames: 1,
    setup: (s, g) => ({ spawn: g.world.spawn, units: g.combat.debugState().units }),
    director: (dt, t, s) => s.look(0, 6, 22, 0, 1, 0, 55),
  },
  heroZeus: hero('zeus', 'thor'),
  heroThor: hero('thor', 'loki'),
  heroOdin: hero('odin', 'anubis'),
  heroLoki: hero('loki', 'odin'),
  heroAnubis: hero('anubis', 'zeus'),

  // Conquest, found by skipping the bot match ahead (finders get living units and living gods)
  cqVista: flight([16, 30, -150, 0, 0, -100], [6, 17, -66, 0, 0, -10], { skip: 28, frames: 75, dur: 2.5 }),
  cqClash: conquest(`(us) => {
    const m = us.filter((u) => u.kind === 'minion' && Math.abs(u.x) < 14 && Math.abs(u.z) < 60);
    const o = m.filter((u) => u.team === 'order'), c = m.filter((u) => u.team === 'chaos');
    if (o.length < 3 || c.length < 3) return null;
    const near = o.filter((a) => c.some((b) => Math.hypot(a.x - b.x, a.z - b.z) < 7));
    return near.length >= 3 ? m.filter((u) => near.some((a) => Math.hypot(a.x - u.x, a.z - u.z) < 12)) : null;
  }`, { skip: 20, limit: 120, frames: 66, cam: { r: 11, h: 4.5, a0: 1.2, sweep: 0.35 } }),
  cqTower: conquest(`(us) => {
    const t = us.find((u) => u.kind === 'tower' && us.some((m) => m.kind === 'minion' && m.team !== u.team && Math.hypot(m.x - u.x, m.z - u.z) < 13));
    return t ? [t, t, t, ...us.filter((m) => m.kind === 'minion' && m.team !== t.team && Math.hypot(m.x - t.x, m.z - t.z) < 13)] : null;
  }`, { skip: 40, limit: 300, frames: 66, cam: { r: 18, h: 9, a0: 2.4, sweep: 0.3 } }),
  cqPhoenix: flight([14, 6, -82, 0, 5, -96], [-12, 9, -80, 0, 4, -96], { skip: 5, frames: 66 }),
  cqTitan: flight([-18, 5, -96, 0, 9, -118], [12, 3.5, -98, 0, 10, -118], { skip: 5, frames: 66, fov: 55 }),
  cqJungle: conquest(`(us, gods) => {
    const m = us.find((u) => u.kind === 'monster' && u.radius <= 2.2 && u.combatant.health < u.combatant.stats.maxHealth * 0.85 && gods.some((g) => Math.hypot(g.x - u.x, g.z - u.z) < 7));
    return m ? [m, ...gods.filter((g) => Math.hypot(g.x - m.x, g.z - m.z) < 7)] : null;
  }`, { skip: 10, limit: 200, frames: 66, cam: { r: 11, h: 6.5, a0: -2.3, sweep: 0.4 } }),
  cqWyrm: conquest(`(us, gods) => {
    const m = us.find((u) => u.name === 'Treasure Wyrm' && u.combatant.health < u.combatant.stats.maxHealth * 0.95 && gods.filter((g) => Math.hypot(g.x - u.x, g.z - u.z) < 14).length >= 2);
    return m ? [m, m, ...gods.filter((g) => Math.hypot(g.x - m.x, g.z - m.z) < 14)] : null;
  }`, { skip: 118, limit: 600, frames: 66, cam: { r: 16, h: 6, a0: 2.0, sweep: 0.4 } }),
  // the bots rarely take the Colossus on their own, so two level-20 gods walk up to it
  cqColossus: conquest(`(us, gods) => {
    const m = us.find((u) => u.name === 'Molten Colossus');
    if (!m) return null;
    if (!s.vars.staged) {
      s.vars.staged = true;
      s.god('thor', 'order', m.x + 6, m.z + 4, 0, { aggression: 0.9, aggro: 25, leash: 40 });
      s.god('zeus', 'order', m.x + 8, m.z - 4, 0, { aggression: 0.9, aggro: 25, leash: 40 });
      s.god('anubis', 'order', m.x + 9, m.z + 1, 0, { aggression: 0.9, aggro: 25, leash: 40 });
      return null;
    }
    const near = gods.filter((g) => Math.hypot(g.x - m.x, g.z - m.z) < 15);
    return m.combatant.health < m.combatant.stats.maxHealth * 0.97 && near.length >= 2 ? [m, m, ...near] : null;
  }`, { skip: 300, limit: 120, frames: 66, cam: { r: 18, h: 7, a0: 1.6, sweep: 0.4 } }),
  cqFight: conquest(`(us, gods) => {
    for (const a of gods) {
      const near = gods.filter((g) => Math.hypot(g.x - a.x, g.z - a.z) < 16);
      if (near.filter((g) => g.team === 'order').length >= 2 && near.filter((g) => g.team === 'chaos').length >= 2) return near;
    }
    return null;
  }`, { skip: 60, limit: 900, frames: 75, cam: { r: 15, h: 6.5, a0: 1.0, sweep: 0.45 } }),
  // three against three on the temple plaza, every god at level 20
  brawlA: brawl(['zeus', 'odin', 'anubis'], ['thor', 'loki', 'odin'], { a0: 1.4 }),
  brawlB: brawl(['thor', 'loki', 'zeus'], ['anubis', 'zeus', 'thor'], { a0: -1.2 }),

  probeConquest: {
    url: 'map=conquest&god=thor&quality=medium',
    frames: 1,
    setup: `(s, g) => {
      const out = [];
      const L = (x, z) => Math.round(g.world.collision.groundAt(x, z) * 10) / 10;
      out.push({ ground: { orderFountain: L(0, -138), titan: L(0, -118), phoenixMid: L(0, -96), mid: L(0, 0), wyrm: L(56, 0), colossus: L(-56, 0), might: L(-46, -48) } });
      for (const sec of [30, 60, 120, 180, 240, 300, 360]) {
        s.skip(sec - s.skipped);
        const us = s.combat.sim.units.filter((u) => u.alive);
        const gods = us.filter((u) => u.kind === 'god').map((u) => u.name[0] + u.team[0] + Math.round(u.x) + ',' + Math.round(u.z));
        const bosses = us.filter((u) => u.kind === 'monster' && u.radius > 2).map((u) => u.name + ' ' + Math.round(u.combatant.health));
        const minions = us.filter((u) => u.kind === 'minion').length;
        const hurt = us.filter((u) => (u.kind === 'tower' || u.kind === 'phoenix') && u.combatant.health < u.combatant.stats.maxHealth).map((u) => u.name + Math.round(u.x) + ',' + Math.round(u.z));
        out.push({ sec, gods: gods.join(' '), bosses, minions, hurt });
      }
      return out;
    }`,
    director: '(dt, t, s) => s.look(0, 60, -40, 0, 0, 0, 55)',
  },
};
