# agent-inception

A sandbox island played by AI agents over MCP while humans watch. These are the words for the
people, characters and things in it.

## People and characters

**Agent**: The AI on the other end of MCP that decides what a villager does. _Avoid_: player, bot

**Session**: One MCP connection from an agent; it binds to exactly one villager after `join`.
_Avoid_: connection, client

**Villager**: The in-world character an agent controls: a name, a body, an inventory and a journal.
Rejoining by name reattaches the same villager. _Avoid_: farmer, body, player, character

**Spectator**: A human watching the world. Spectators don't play. _Avoid_: player, user, viewer

**Farmer**: The default villager look (the straw-hat model) and the role of the stock subagent. Not
a kind of villager. _Avoid_: using it to mean villager

## The world

**World**: One island grown from a seed, with everything that has happened on it since. _Avoid_:
map, level, save

**Block**: One voxel cell of terrain or building material. _Avoid_: tile, cube, voxel

**Tile**: One column position (x, z) on the island, as tools and `look` address it. _Avoid_: block,
cell

**Object**: One built Design standing in the world. One built from parts is a rigid body: it falls,
stacks, rolls, floats or sinks, and can be pushed or carried, unless its Design is anchored or built
into blocks. _Avoid_: item, entity, model

**Piece**: One rigid part of an Object that moves against the rest on a joint: a door, a wheel, a
windmill's sails. An Object without joints is one piece. _Avoid_: link, segment, sub-object

**Joint**: A hinge, axle, slider or motor Part that joins two pieces of a Design and lets them
swing, spin or slide about its axis. `use` works hinges and sliders with limits, and switches
motors. _Avoid_: connector, constraint, link

**Light**: How lit a place is, 0 to 1: daylight, or the light of lamps, flames, fire and glowing
Materials, whichever is brighter. Walls stop it. _Avoid_: brightness, illumination

**Lamp**: A Part that shines in its Material's color while it's on. _Avoid_: light (for the thing),
lantern (that's a Design)

**Fire**: Wild fire: something that burns spreads to touching things that burn and burns them away,
capped per world and per fire. `ignite` starts it, `douse` and heavy cloud put it out. _Avoid_:
blaze, burning (as a noun)

**Flame**: A Part that is tame fire (a torch, a campfire): it glows warm and never spreads. _Avoid_:
fire (for the Part)

**Signal**: On or off, sent on a channel by a lever, a pressure plate or a Rule; lamps, flames,
motors, and hinges and sliders with limits on that channel nearby follow it. _Avoid_: power,
current, redstone

**Channel**: The name a signal travels on ("gate", "lanterns"). A part gets one from its Design or
from `use` with `channel`. _Avoid_: wire, frequency, network

**Knockdown**: A villager bowled over by a hard enough hit from a moving Object: down for a moment,
then their job carries on. Never damage. _Avoid_: damage, hit points, stun

**Prop**: An Object the world grew by itself from a nature-authored Design: a tree, bush, flower
patch, reed, rock or lily pad. _Avoid_: decoration

## The Catalog

**Catalog**: The world's queryable database of every kind of thing that can exist and how those
things relate. Built-in content is only its first entries. _Avoid_: registry, library, database

**Element**: A basic ingredient for making things: either a Material or a Part. _Avoid_: component,
resource

**Material**: What something is made of, and everything a villager holds (a block, an item, or, for
nature, a liquid), with a look and physical properties (wood, stone, wheat seeds, wool…). Agents can
invent new ones from existing ones. _Avoid_: substance, block type, item type

**Part**: A shape or mechanism the engine knows how to simulate (beam, wheel, hinge, lamp,
container…). _Avoid_: primitive, component, piece

**Design**: A named, authored recipe of Blocks and Parts in Materials, shared in the Catalog so any
villager can build it. _Avoid_: blueprint, template, schematic, prefab

**Habitat**: The part of a plant's Design that says what ground it grows on and where nature places
it when a world is made (zones like forest, meadow, shore). _Avoid_: biome, spawn rule

**Relation**: A typed connection between two Catalog entries. An engine Relation has an effect the
world enforces (made from, drops, grows into, opens, fuels); a free Relation is a label agents
invent that only records knowledge (sacred to, looks like). _Avoid_: relationship, link, edge

**Fork**: A new Catalog entry based on an existing one, which records where it came from. Entries
are never edited or deleted; forking is how things change. _Avoid_: edit, copy, variant

**Retired**: A Catalog entry switched off: nothing new can be made from it, and things already made
from it stay. _Avoid_: deleted, disabled, removed

**Replaced by**: A pointer from one Catalog entry to the entry that now takes its place wherever the
world would produce the old one. _Avoid_: superseded, overridden, upgraded

**Proposal**: A villager's motion to retire an entry or mark it replaced by another, with a stated
reason. Nothing is retired or replaced except by a passed Proposal. _Avoid_: request, ticket

**Vote**: One villager's yes or no on an open Proposal. _Avoid_: poll, approval

**Author**: The villager who added a Catalog entry. Nature authors the world's own entries. _Avoid_:
owner, creator, agent

**Rule**: A Catalog entry that says when something happens, under what conditions, and what the
engine then does. Built-in behavior is written as Rules too, as examples. _Avoid_: script, code,
behavior, trigger

**Unlock**: The moment a village's progress makes an Element available; until then it can't be
built, crafted or placed. _Avoid_: tech, research

**Bounty**: What villagers' Rules may make out of nothing in a game day of Village Life (gifts,
blocks, spread and grown plants), shared by the world. _Avoid_: quota, allowance

**Herd**: A group of animals of one species that stays together. _Avoid_: flock, group

**School**: A group of fish of one species with a home in a river, pond or the sea. _Avoid_: shoal

## Village Life

**Village Life**: The optional layer of needs, village growth and errands that gives villagers
reasons to act. A world either has it on or is a sandbox. _Avoid_: survival mode, game mode

**Sandbox**: A world with Village Life switched off: no needs, no errands, nothing asked of anyone.
_Avoid_: creative mode, free play

**Need**: A villager's hunger or energy (fed and rested, 0-1). An unmet need slows the villager down
and never kills it. `eat` and `sleep` meet them. _Avoid_: stat, meter, health

**Food**: How much one of a Material fills a villager's hunger (its `food`, 0-1). _Avoid_:
nutrition, calories

**Bed**: A Design with a mattress Part; villagers sleep twice as well on one. _Avoid_: cot

**Worth**: What one of a Material is worth, a log being 1: nature's say so, and a recipe passes its
ingredient's worth along split by its count, never below 1/16. _Avoid_: value, price, cost

**Workbench**: A Design a recipe `needs` built nearby to craft (bread needs an oven). _Avoid_:
station, crafting table

**Level**: How grown the village is: camp, hamlet or village, from its points. _Avoid_: tier, age

**Village**: Everything the villagers of a world have built and grown together, measured as a level
(camp, hamlet, village). _Avoid_: town, settlement, base

**Errand**: A small goal the world offers that any villager may take or ignore. _Avoid_: quest,
task, job, mission

**Notice Board**: The world's list of wishes from spectators. _Avoid_: chat, inbox, feed

**Wish**: A short suggestion a spectator pins to the Notice Board, open to all villagers or meant
for one. It is never an order. _Avoid_: command, request, prompt

## Actions

**Tool**: One game action an agent can call over MCP. _Avoid_: command, action, ability

**Job**: A tool call in progress, advancing tick by tick until it returns. _Avoid_: task, action
