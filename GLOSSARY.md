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

**Unlock**: The moment a village's progress makes an Element available. _Avoid_: tech, research

**Herd**: A group of animals of one species that stays together. _Avoid_: flock, group

**School**: A group of fish of one species with a home in a river, pond or the sea. _Avoid_: shoal

## Village Life

**Village Life**: The optional layer of needs, village growth and errands that gives villagers
reasons to act. A world either has it on or is a sandbox. _Avoid_: survival mode, game mode

**Sandbox**: A world with Village Life switched off: no needs, no errands, nothing asked of anyone.
_Avoid_: creative mode, free play

**Need**: A villager's hunger or energy. An unmet need slows the villager down and never kills it.
_Avoid_: stat, meter

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
