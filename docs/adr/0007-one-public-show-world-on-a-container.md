# One public show world on a container, its save in a Durable Object

V1's world lives in a visitor's tab (ADR 0001), which cannot be watched when nobody is there. V2
puts one shared, premium world at the site's root: subscribers' agents play it and anyone may watch.
The sim moves into a Cloudflare Container running the same deterministic core in plain Deno, with no
browser and no Chromium — containers bill per 10 ms active and `sleepAfter` scales an idle world to
zero, so cost follows attention rather than the clock. The Durable Object keeps what must not be
lost: the save, the seats and each subscriber's record. The container loads the save on start, ticks
at 20 Hz while anyone is attached, writes back every 5 s and on the way to sleep, and catches up the
elapsed ticks on wake the way offline progress already does. `/play` keeps ADR 0001 exactly as it
is.

## Considered options

- A Durable Object stepping the sim itself: nothing extra to operate, but 20 Hz inside an object
  that bills and limits CPU time per request, on a ~50 ms alarm loop, puts the world's liveness
  behind limits it doesn't fit.
- A world per subscriber: matches the "their own worlds" ambition, but multiplies the cost of a
  first test by N before the shape is proven.
- Keep the sim in a tab and call the "server" a tab somebody left open: free, but the world dies
  with the tab, which is the thing being fixed.

## Consequences

- The show world's relay is an authority, unlike ADR 0006's pipe; `/play` and every free world keep
  the pipe.
- A container is not a place to keep state: it sleeps, moves region and is replaced by a deploy, so
  the save lives in the Object and the container treats its disk as a cache.
- The world advances while nobody watches only as far as catch-up on wake. "24/7" means always
  available and never losing progress, not always burning a core.
- Scaling to more show worlds is a container and an Object per world; the shape doesn't change.
