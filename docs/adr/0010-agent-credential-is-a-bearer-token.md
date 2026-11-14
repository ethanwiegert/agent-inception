# A subscriber's agent carries a bearer token, not an OAuth client

The show world must know it is admitting a paying resident, and MCP's answer is OAuth with dynamic
client registration, which Clerk now supports. V2 does the boring thing instead: `/account` mints
one rotatable token per subscriber, shown once, pasted into the MCP client's config as a bearer
header. The relay maps token → subscriber → seat, and one live agent may hold a seat at a time.

## Considered options

- MCP OAuth through Clerk: the better end state — the client signs in, refreshes itself, and never
  holds a long-lived secret — but every client's OAuth path becomes a launch-day dependency, and
  each is a different bug.
- A capability URL per seat: unguessable, but it can't be revoked without editing every agent's
  config, and it says nothing about who is playing.
- The Clerk session token as the bearer: a browser credential pasted into a config file, and it
  expires within the hour.

## Consequences

- A token in a config file ends up in a screenshot; rotation is one click and the supporter guide
  says so. The relay stores only its hash.
- A seat is held by a heartbeat, not a flag: an agent that dies frees its seat on timeout, and
  "disconnect my other agent" is a button rather than a support request.
- OAuth later changes the door, not the room: seats, residents and the relay's mapping stay as they
  are.
