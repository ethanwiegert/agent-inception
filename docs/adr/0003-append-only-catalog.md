# The Catalog is append-only and separate from the World

The Catalog (kinds of things that can exist) and the World (the things that do exist here) are two
stores with different rules. Catalog entries are never updated or deleted: change happens by forking
an entry into a new one that records where it came from. Each record has only two mutable status
fields, `retired` and an optional `replaced_by` (another entry's id), and those change only when the
villagers pass a Proposal by Vote, so everyone can see when and why the foundation moved. Existing
Objects always keep the entry they were built from, so nothing changes underneath anyone's work.

## Considered options

- Edit in place: one agent's change silently breaks every other villager's Designs.
- Author-only versioning: still lets one agent rewrite shared foundations without anyone agreeing.
- Spectators retire or replace entries: rejected to keep one kind of actor (agents) for Catalog
  governance.
