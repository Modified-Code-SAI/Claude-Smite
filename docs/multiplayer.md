# Multiplayer

Co-op and versus Conquest, peer to peer, with no server of our own.

## Connecting

`src/net/Session.ts` wraps [PeerJS](https://peerjs.com). The host registers the peer id `ascendant-lobby-<CODE>` on the free public PeerJS signaling server; guests connect to that id. After the WebRTC handshake, all traffic runs over direct data channels (reliable, ordered, JSON text). PeerJS's default ICE servers include Google STUN and PeerJS's free TURN relays, so most home networks connect.

The lobby (`LobbyPanel.ts`, on the title screen) lists the players; the host owns the player list and broadcasts it on every change. **Start match** sends the list to everyone, and every end builds the same ten god slots from it (`roster.ts`): humans take the mid, solo, roam and duo spots of their team in that order, and bots play the rest with gods no human on their team picked.

## Host-authoritative match

Only the host runs the simulation (`NetHost` in `NetGame.ts`). Bots think there, and each guest's god is a plain body that follows that guest's inputs:

- Guests send one input per fixed step: position, facing, aim point, whether the basic attack is held, and their **authority sequence**. Casts, recalls and loadout/tree changes are separate messages.
- Guests own their normal movement, so walking feels instant. The host owns everything else: when it moves a guest's god itself (a teleport, respawn or recall, or the end of a dash, leap or knockback) it bumps that player's sequence. Inputs sent before the guest saw the bump are ignored, and the guest snaps its controller to the host's position.

## Snapshots

`Replica.ts` sends each guest a snapshot 20 times a second (`HostSync`), holding only what changed since that guest's last one: units' positions and timers, rules-engine state (`Combatant.netState`, 10 times a second), new units (with their `Unit.origin`, so the guest builds the same minion, monster or summon), removed units, projectiles, areas, flashes, the events since the last snapshot, the match clock and the scoreboard. Timers travel as the match time they end at, so a unit that is only counting down is not resent. A busy match costs a guest about 60 KB/s.

Guests (`GuestSync`) never step the simulation. They draw the match 0.12 s in the past, interpolating positions between snapshots, and apply each snapshot's events and state when the delayed clock reaches it. Events go to the same views, effects, HUD and audio as in a single-player match; the guest's match drops its own event listeners so nothing is counted twice.

## Online play for any mode

The lobby hosts whatever mode the title screen has selected. A mode's entry in `MODES` (`src/ui/StartMenu.ts`) lists the lobbies it offers in `net` (co-op and/or versus, each with a player cap); a mode without `net` is single player. The lobby and start messages carry the mode's id (`NetSession.game`), so a guest who joins by code or link lands on the host's mode.

To make a mode playable online, its setup in `CombatGame` builds the same units in the same order on every end (from `net.players`), then:

- **Host:** `new NetHost(session, sim, toBot, toast)`, `host.assign(playerId, unit)` for each guest's unit, then `host.bind(netMatch, roster)`. `roster.slots` are the god slots and `roster.structures` any other units both ends build up front, by name.
- **Guest:** `new NetGuest(session, sim, netMatch, roster, myUnit, controller)`, and clear `sim.listeners` (the host's events arrive ready-made).
- **`NetMatch`** (`Replica.ts`) is the mode's side of the snapshot: `netState()`/`applyNet()` for its own state (score, phase, clock), optional `gods`/`stats` for the scoreboard, `netTargets()` for targeting beams, and `netSpawn()` for units the mode makes mid-match (give them `origin: { f: 'mode', kind, data }`). Conquest's `Match` implements it.
- **Mode messages:** `guest.act({ ... })` reaches `host.onAct(unit, msg)` with that guest's unit (a vote, a throw). `host.basic` carries out a guest's held basic attack and can be replaced (a relic carrier throws instead).
- **Moving a player:** `host.assign(player, otherUnit)` hands a guest another unit mid-match (a rotation). Their next snapshot says so; `guest.onSelf(unit)` must move the controller's body onto that unit (`unit.body = …`) before returning, and the controller then snaps to where the host has it.
- Any `sim.teleport` of a guest's unit bumps their authority sequence, so teleporting gods between rooms needs nothing extra.

Relic Rush (`src/combat/RushMode.ts`) is a small example: both ends build six gods from `rushRoster` (`src/net/rushRoster.ts`, three a side, bots fill in), `Rush` is the `NetMatch` (score, clock, phase and the relic, with gods sent as their place in the line-up), a guest carrier's click goes `act({ k: 'throw', a })` to the host, and between snapshots a guest's copy keeps a thrown relic flying on its own (`Rush.follow`).

Underworld Descent (`src/combat/DescentMode.ts`) is the co-op example: up to four friends, bots fill the team to three (`src/net/descentRoster.ts`). `Descent` is the `NetMatch`; its monsters travel with `origin: { f: 'mode', kind: 'descent' }` and the guest rebuilds them in `netSpawn`. Votes and skill picks go `act({ k: 'vote' | 'draft', i })`. A guest keeps its own loadout, so the host's state lists the skills each god learned and the guest learns them too (its own pick is learned at once). `src/net/descentnet.test.ts` mirrors a run from host to guest.

Its versus lobby is a shared descent: two teams of up to three in the same chambers, scored in souls (`DESCENT.versus` and `SOULS` in `src/sim/Descent.ts`). Teams may be uneven. Each team chooses whether bots fill its empty spots: `NetSession.bots`, set with `setBots(team, on)` (the host for any team, a guest only for its own) and shown in the lobby when the mode's host option has `bots: true`. A team with no humans is always three bots. The smaller team gets lasting damage perks and its souls count per head (`Descent.soulRate`); `vs` in `DescentNet` carries the score, the teams voting on the current offer and which team took each boon.

## Testing locally

```sh
npx peerjs --port 9000 --host 127.0.0.1   # a local signaling server (the `peer` dev dependency)
npm run dev
```

Open `http://localhost:5173/?peer=127.0.0.1:9000` in two windows, host in one and join in the other. `src/net/*.test.ts` cover the snapshot copy (a bot match mirrored for 100 s) and the input/authority handshake.
