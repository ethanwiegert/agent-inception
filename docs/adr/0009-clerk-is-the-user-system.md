# Clerk is the user system, the plan, and nothing else

Accounts are Clerk's: sign-in, session tokens, the subscriber's profile and the billing plan, so
compliance, password resets, MFA and the customer portal are not ours to build. It is the repo's
first runtime dependency, and the only one. The Worker verifies Clerk's session JWT against its JWKS
with WebCrypto rather than adding an SDK on the server, and Clerk's components load on `/account`
only, so the game page never pays for any of it. Entitlement is written into the Durable Object's
storage by Clerk's Billing webhook, keyed by Clerk user id; the token's plan claim is a fast path,
never the record.

## Considered options

- Stripe directly: a second vendor and a hand-built portal for a single-product plan.
- Our own auth: cheap to write, expensive to be wrong about.
- A second database as well: nothing in V2 needs one — the Object's storage holds seats and token
  hashes — and a refined store can arrive with subscriber-owned worlds, when it has a reason.

## Consequences

- No user table of ours, so Clerk's user id is the identity everywhere, including the Object's keys.
  Deleting a Clerk user orphans that record; the webhook's deletion path has to clean up.
- Clerk is lock-in of the kind that would take a quarter to leave: the only place holding a user is
  Clerk plus one Object per world, and that is the whole point of the choice.
- Zero dependencies stays true for the sim and the renderer; it stops being true for the account
  pages, and the pin lives in `deno.json` with a note saying why it is the only one.
