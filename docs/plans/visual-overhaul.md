# Visual overhaul plan

A plan for an agent to carry out. It takes the renderer from "a lit forward pass with nice sky and
grass" to a frame with depth: grounded shade, shadows to the horizon, light shafts, water that
refracts and mirrors, surfaces that catch the sun, and an island that looks alive when nothing is
happening. Rendering only (`src/render/`, a little of `src/main.ts`, `src/devpanel.ts`, `tools/`):
no sim, tool, Catalog, or save changes.

Read `CLAUDE.md`, the art direction in `docs/DESIGN.md`, and `src/render/frame.ts` and
`src/render/renderer.ts` in full before starting. Work in the phase order below; each phase stands
on its own and ships with before/after pictures.

## Where the renderer is today

One multisampled forward pass, then post:

```
compute  models-cull (flora ×2 views, ground cover), grass cull
shadow   one 2048² ortho map around the camera target (half-extent max(24, distance × 1.1))
main     4× MSAA rgba16float + depth24plus, resolved, depth discarded:
         terrain → bodies → flora → crops → grass → sky → water (blended) → particles
bloom    quarter-res threshold + 4 levels
post     exposure, PBR Neutral tonemap, grade, sharpen, vignette, dither → canvas / capture
```

What that structure cannot do, and what four captures of seed 7 (noon, dusk, close, night; software
adapter) show:

- **Nothing reads scene depth or color.** Depth is discarded and water blends in the same pass, so
  there is no refraction, no reflection of the land, no soft shoreline against Objects, no ambient
  occlusion, no light shafts. Water depth comes from the surface texture (`floorAt`), so anything
  that isn't a column top (Objects, villagers, plants) meets the water with a hard line.
- **Things float.** Trees, bushes, and villagers have no contact shade beyond the shadow map; under
  cloud or at dusk they sit on the meadow like stickers. The meadow itself is one saturated green
  with only low-frequency tint; the only occlusion is per-vertex voxel AO on terrain and a root
  darkening in the blade.
- **Shadows stop at the shadow box.** `shadowAt` returns 1 outside the map, so at low pitches
  everything past ~`distance` blocks from the target is unshadowed and the far hills go flat.
- **The air has no light in it.** `fog()` is distance haze plus a dawn/dusk mist term. No shafts
  through crowns, no glow around lamps, no height falloff by day.
- **Clouds are a 2D layer.** PR #41 gave them shading and form, but they have no parallax or
  thickness and sit behind everything.
- **Surfaces are albedo only.** `patternAlbedo` is good procedural color, lit by Lambert + hemi.
  Nothing glints: stone, wet sand, tiles, planks all have the same matte response.
- **Night is one flat blue.** The moonlit grade crushes everything to a narrow blue range; moon
  shadows barely read, stars are sparse, and nothing but lamps breaks the monotone.
- **Stillness.** With no agent on screen the only motion is grass, crowns, water, clouds.

## Rules that bound the work

- Zero dependencies, no texture or model assets: everything stays procedural or generated at
  startup. WebGPU only.
- Art direction holds unless Ethan changes it: Natural is the default look; colors stay true (PBR
  Neutral tonemap, no hue-shifting grade on midtones); no lines across the screen (no block-grid
  outlines, no black shadow stripes); low-poly crowns without leaf textures.
- `src/sim/` is untouched. Anything new that moves must be a function of time and position on the
  GPU, or derived from data the page already has (`SceneState`).
- No per-frame allocations in the frame loop. New CPU-side buffers are allocated once and reused.
- `F` offsets and the WGSL `Frame` struct change together; everything stays `mat4x4f`/`vec4f`.
- Every new pass gets a `?debug=` skip name and is listed in `Renderer.debug`'s comment and
  `CLAUDE.md`'s URL params.
- WGSL gotchas from `CLAUDE.md` apply (one declaration per `let`, no `pow` of a negative base,
  shader errors only show in `__perf.gpuErrors`).
- The budget is 60 fps at 1080p on an integrated GPU. It can't be measured on a cloud VM (software
  adapter, `gpuMeasured: false`), so every phase must (a) be reasoned in shaded pixels × taps, (b)
  not regress the software before/after frame time by more than its stated share, and (c) be
  switchable by tier so Ethan can measure on hardware.

## Target frame

```
compute   models-cull, grass cull (reads field map + pushers)
clouds    half-res cloud slab → cloud target                       [high]      debug: clouds
shadow    cascade 0 (near, every frame), cascade 1 (far, amortized)            debug: shadow
opaque    4× MSAA color + depth, both stored; resolved to `opaque`
          terrain → bodies → flora → crops → grass → sky (composites clouds)
depth     MSAA depth → half-res linear depth (r16float)            [med+]
ao        half-res GTAO + bilateral blur                           [med+]      debug: ao
shafts    quarter-res sun shafts + lamp glow through shadow map    [med+]      debug: shafts
trans     same MSAA color (load), depth read-only + sampled:
          water (refraction, SSR, soft shore) → particles → ambient life       debug: water, life
bloom     as today, better filter                                               debug: bloom
post      AO × scene + shafts + bloom → exposure → tonemap → grade → sharpen
```

Low tier (software adapters, and the adaptive governor's last resort) keeps today's single pass: no
stored depth, no `depth`/`ao`/`shafts`/`clouds` passes, water without scene inputs. The field map,
pushers, cascade 1, surface, vegetation, sky, night, and ambient-life work all still apply.

## Phase 0: harness and tiers

Do this first; every later phase depends on comparing pictures.

1. **Shot set.** Add `tools/shotset.ts` and a `shotset` task: build once, launch once, and capture a
   fixed list of poses through `__game.capture(width, height, pose, atMs)` into a directory, with a
   JSON of `__perf.summary()` and `__perf.gpuErrors` per shot. Hold weather before each capture
   (`__game.client.send({ type: "weather", clouds })`) and pass a fixed `atMs`; natural weather
   drifts with time of day, and seed 7 is overcast at dusk. Suggested set on `seed=7&speed=0` (pitch
   ≥ 0.15, or the eye ends up in the terrain):
   - `noon-wide` time 0.5, distance 60, pitch 0.35, yaw 2.1
   - `noon-horizon` time 0.5, distance 45, pitch 0.16, yaw 0.6
   - `morning-close` time 0.32, distance 18, pitch 0.3, yaw 4.0
   - `dusk-into-sun` time 0.74, distance 45, pitch 0.18, yaw toward the sun
   - `night-moon` time 0.95, and `night-lamps` (place a few lamp Objects and a fire first through
     `__game.call`)
   - `shore` and `river` (pose over water at distance 14-20; find the offsets once and fix them)
   - `overcast` time 0.5, clouds 0.9
   - `village`: a scripted build (planks, bricks, stone, tiles, thatch, glass if present, a lamp) so
     built Materials are in frame. A fresh profile's world is empty.
   - one shot per alternate look (`crisp`, `lush`, `storybook`) at `noon-wide`
2. **Baseline.** Run it on `main`, keep the directory outside the repo, and write down the software
   frame times. Each phase's PR shows the same shots after.
3. **Tiers.** Add `quality: "low" | "medium" | "high"` to the renderer (`?quality=` fixes it).
   Default: software adapter → low; otherwise high. Extend `adaptScale` in `src/main.ts` so a slow
   GPU steps high → medium before it gives up resolution, and earns it back last. Changing tier
   recreates `SceneTargets` and picks pipeline variants; it must not rebuild chunk meshes.
4. **Timer.** `GpuTimer` spans shadow-pass start to post-pass end. Move its start to the first pass
   of the frame when passes are added ahead of the shadow pass.

Acceptance: `deno task shotset out/` produces the set in one launch with `errors: []`; `quality`
round-trips through the URL and the spectator panel; `deno task check` and `deno task test` pass.

## Phase 1: a frame that keeps its depth

The foundation. No visible change by itself except water.

- **Split the main pass** in `Renderer.render` into `opaque` and `trans`. `opaque` stores MSAA color
  and depth and resolves into a new single-sample `opaque` texture. `trans` loads the MSAA color,
  resolves into the existing `resolve`, and binds the depth attachment with `depthReadOnly: true`
  (water and particle pipelines already have `depthWriteEnabled: false`).
- **Depth as a texture.** Give `SceneTargets.depth` `TEXTURE_BINDING`; bind it in `trans` as
  `texture_depth_multisampled_2d` (read with `textureLoad(depth, px, 0)`).
- **Scene group.** A new bind group for transparent passes: `opaque` color + sampler, scene depth.
  Add `depthParams` (near 0.5, far 4000, 1/width, 1/height) to `Frame` and a `linearDepth(d)` helper
  in `commonWgsl`.
- **Half-res linear depth** (`render/depthdown.ts`): one fullscreen pass, farthest of the 2×2
  footprint's sample-0 depths, into `r16float`. Used by AO and shafts; medium tier and up.
- **Low tier** keeps the single pass. Build the water shader as two modules from one template
  (`sceneInputs: boolean`) rather than branching at runtime.
- Captures use `shotTargets`: make sure every new target is created per `SceneTargets`, so a
  1024×640 agent screenshot and the view don't share textures.

Cost to watch: storing and reloading 4× MSAA rgba16float is the one real price here (tile-based and
integrated GPUs pay for it in bandwidth). If the software before/after or Ethan's hardware number
says it's too much, fall back to resolving water without per-sample depth at medium tier.

Acceptance: pictures identical to baseline at every tier (diff the shot set); no GPU errors.

## Phase 2: grounding

The largest change in how the island reads, and most of it is nearly free.

### 2a. Field map (all tiers)

`render/fieldmap.ts`: a world-sized `rg8unorm` texture (256², filtered), added to the frame group as
binding 5 so terrain, grass (compute), crops, and water can all read it.

- **r: sky occlusion.** How much open sky a patch of ground sees. Rasterize on the CPU into a reused
  `Uint8Array`: a soft disc under every tree and bush (radius and weight from the plant's crown
  size; `buildProps` in `flora.ts` already walks every prop with its position and growth scale, on
  the same rebuild cadence), plus the heightfield term: columns at the foot of cliffs, walls, and
  under roofs lose sky in proportion to the solid blocks above and beside them. Blur once
  (separable, 2-3 texels).
- **g: shore distance.** Signed distance to the nearest water/land boundary, ±8 blocks mapped to
  0-1, by a two-pass chamfer or BFS over the surface texels.
- Rebuild on `props.version` / `surface.version` change, throttled to a few times a second, never
  per frame. Upload with `writeTexture`.

Use it:

- Grass compute multiplies the blade's root and tip color and its key light by the occlusion: the
  meadow darkens and cools under crowns and at the foot of walls, even with no sun.
- `terrain.ts` `fs`: ambient × occlusion. Replace the 4-tap `wetness()` with the shore distance
  (plus the existing noise wobble), so the wet band is a smooth curve at any angle.
- Meadow color: lusher near water, drier on open hilltops (shore distance + height), widening
  `meadowColor`'s range. At noon the meadow is currently one neon green; aim for visible drifts of
  color at the 20-60 block scale without changing the look's base colors.
- Water: foam, shallow tint, and lapping lines keyed on shore distance (see phase 6).

### 2b. Pushers (all tiers)

Add `pushers: array<vec4f, 16>` (xyz, radius) to `Frame`: the villagers and animals nearest the
camera target, filled from `scene.agents` / `scene.animals` without allocating.

- Grass compute bends blades away from a pusher and presses them down within its radius: villagers
  leave a moving parting in the meadow.
- Terrain and grass darken in a soft blob under each pusher (analytic, radius-normalized). Bodies
  stay grounded under overcast, at night, and at zoom levels where the shadow map can't resolve
  them.

### 2c. GTAO (medium and high)

`render/ao.ts`: half-res horizon-based AO from the half-res linear depth (normals reconstructed from
depth derivatives). 2 slices × 4 steps at medium, 3 × 6 at high, interleaved-gradient noise rotated
per pixel, then a 4×4 depth-aware blur into `r8unorm`. Radius ~1.5 blocks in world space, fading out
past ~120 blocks.

Applied in post, since the forward pass has already lit the pixel: `scene × mix(1, ao, k)` with `k`
reduced on bright sunlit pixels (so it mostly eats ambient) and upsampled depth-aware so it doesn't
halo around silhouettes. Keep it subtle (the rule against black stripes applies): step corners,
doorways, the inside of crowns, where trunk meets ground.

Acceptance: in `noon-wide` and `overcast`, every tree and bush sits in a pool of shade; in
`morning-close` the villager parts the grass; no dark halos around silhouettes against the sky; low
tier shows 2a and 2b.

## Phase 3: shadows to the horizon

- **Two cascades** in a 2-layer `depth32float` array (`texture_depth_2d_array`). Cascade 0 is
  today's box. Cascade 1 covers ~±260 blocks around the target, snapped to texels the same way. Add
  `lightViewProj1` to `Frame`.
- `shadowAt`, `shadowFast`, and the grass compute pick cascade 0 inside its box and blend into
  cascade 1 over the last 10% (no visible seam, no pop when orbiting).
- Cascade 1 is amortized: redraw it when the light direction or its snapped origin moves, and at
  most every other frame. Terrain only plus low-LOD flora; no bodies.
- Slope-scaled bias per cascade; check the smooth-slope hills for acne at dawn.
- While here: fade shadows out at the far edge of cascade 1 into the cloud-shadow term instead of
  ending.

Acceptance: `noon-horizon` shows tree and cliff shadows on the far hills; orbiting and zooming shows
no seam or shimmer; shadow-pass cost at the default pose is within ~15% of today's on the software
before/after.

## Phase 4: light in the air

`render/shafts.ts`, quarter-res, medium and high.

- For each pixel, march from the eye to the scene depth (capped ~180 blocks), 8 steps at medium, 16
  at high, start jittered by interleaved-gradient noise. At each step: shadow (cascade by distance)
  × `cloudLight` × density, where density is a thin base haze plus the low mist already in
  `frame.grassBase.w`, falling off with height above sea level. Phase function: Henyey-Greenstein, g
  ≈ 0.7, toward the sun (or moon, much weaker).
- Add lamplight in the same loop when `frame.extra.w` is set: sample the light field at each step,
  isotropic. Lamps and fires then glow in the night air, and that glow is occluded by walls for
  free.
- Output is additive in-scattered light only. `fog()` stays as the extinction/aerial-perspective
  term in every forward shader, so nothing is counted twice and low tier loses only the shafts.
- 4-tap depth-aware upsample in post; added before bloom so strong shafts bloom slightly.
- Strength by look and by weather: strongest at low sun with broken cloud, nearly absent at noon and
  under full overcast.
- Upgrade `fog()` itself (all tiers): density falls with height by day as well (valleys hazier than
  hilltops), and the in-scatter color leans toward the sun's color near the sun's direction.

Acceptance: `dusk-into-sun` shows shafts between trunks and crowns; `night-lamps` shows a soft
volume around each lamp that walls cut off; no banding or noise visible at 1080p; nothing changes at
noon beyond a slightly deeper valley haze.

## Phase 5: sky and clouds

### 5a. Sky (all tiers)

- Keep `skyZenith`/`skyHorizon` as the two colors that drive ambient, but shape the gradient between
  them: deeper zenith, a paler band at the horizon, and at dusk and dawn the antisolar side (a rose
  band over a blue-grey earth shadow opposite the sun). Sunsets currently tint the whole sky one
  pink.
- Sun: limb darkening and a reddened, slightly flattened disc at the horizon. Moon: a soft halo
  through thin cloud.
- Stars: more of them in more magnitudes, brighter away from the moon, and extinguished toward the
  horizon; the Milky Way a little stronger on moonless nights. A rare shooting star (hash of time).
- Match the far sea to the sky at the horizon: the noon shots show a visible band where sea, haze,
  and sky meet.

### 5b. Cloud slab (high; decide after a prototype)

Replace the 2D layer in the sky with a raymarched slab, keeping the 2D `cloudDensity` as the
coverage map so ground shadows and water reflections still line up with what is overhead.

- A 64³ tileable noise volume (`r8unorm`) generated on the GPU at startup (Perlin-Worley; one
  compute or layered render pass, not CPU: the first-frame budget is under a second).
- `render/clouds.ts`: half-res target, sky pixels only. 10-12 steps through a slab (~240-340 blocks
  up), density = coverage × height profile − erosion; 3 light steps toward the key light;
  Beer-powder shading, silver lining from the phase function, the ambient from the sky colors.
  Output premultiplied radiance + transmittance; `sky.ts` composites it.
- Sunset: lit from below, warm undersides and cool tops. Night: moonlit rims only.
- Prototype behind `?clouds=volume`, compare against the PR #41 layer on the shot set, and ask Ethan
  which to ship before polishing. Low and medium keep the 2D layer.

Acceptance: `noon-wide`, `dusk-into-sun`, `overcast` side by side with baseline; clouds have
thickness and parallax when orbiting; cloud shadows on the ground still match the clouds above.

## Phase 6: water

With scene color and depth available (medium and high; low keeps today's shader plus the
shore-distance work).

- **Refraction.** Sample `opaque` at the pixel offset by the wave normal (scaled by water depth and
  by distance); reject samples in front of the water using scene depth. Stop alpha-blending the
  body: the shader composes refracted floor, absorption, and reflection itself and writes opaque.
- **Absorption from true depth.** Path length through the water from scene depth along the view ray,
  tinted with the existing per-channel absorption. Objects, villagers wading, and reeds then sink
  into the color instead of cutting a line. Keep the shallow teal over sand.
- **Screen-space reflections.** March the reflected ray against scene depth (12-16 steps, linear
  with a binary refine) and fetch `opaque`; fall back to `skyColor` + clouds where the ray leaves
  the screen or finds nothing, fading at the screen edges. Trees, banks, and buildings mirror in
  rivers and ponds. High tier only if medium can't afford it.
- **Shoreline.** Soft intersection with anything (depth difference), foam and lapping lines along
  shore distance instead of column depth, a slow swash that wets and dries the sand band.
- **Waves.** More octaves with analytic derivatives, the two largest aligned to `frame.wind`,
  amplitude growing with open-water fetch (shore distance) so ponds are calm and the sea is not.
  Wind streaks (cat's paws) drifting across open water. Keep the pixel-footprint fade that stops
  moiré on the far sea.
- **Light.** A wider sun glitter path at low sun; stars and the moon reflected at night; caustics
  already on the terrain get a second, sharper octave and fade with depth.
- **Ripples** (ties to phase 9): rings around wading pushers and where fish break the surface,
  written from the pushers array.

Acceptance: `river` shows the bank and trees mirrored and the bed bending under the ripples; `shore`
shows foam following the coast in smooth bands; no hard line where an Object stands in water;
`night-moon` shows a moon path.

## Phase 7: surfaces

All tiers; terrain and built blocks.

- Change `patternAlbedo` into a `patternSurface` that returns albedo, a height, and a roughness per
  pattern. Perturb the normal from the height (screen-space derivatives of the height field the
  pattern already computes: mortar lines, plank gaps, cobble joints, tile edges, furrows). Fade the
  bump and fine albedo detail by the pattern's pixel footprint so distant walls don't shimmer.
- Add one specular lobe for the key light (GGX or Blinn-Phong, roughness from the pattern) and a
  Fresnel-weighted sky reflection for smooth, wet things. Stone and tiles get a soft sheen; wet sand
  and the swash band go glossy and mirror the sky; planks stay matte.
- Cliffs: strata bands and darker seams on tall stone/dirt faces, moss where the field map says it's
  shaded and near grass. No block-grid lines.
- Glowing Materials: emissive already goes through `selfLit`; make it feed bloom convincingly at
  night without washing out by day.
- `models.ts`: the same specular term with a per-Material roughness guess (metal and glass-like
  Materials glint; wood and cloth don't). Verify how a Material's look reaches `designs.ts` before
  adding a field; do not add a Catalog field (that is a sim change): derive from the existing look
  or pattern.

Acceptance: `village` at morning shows mortar, plank, and tile relief catching the light and no
shimmer when orbiting far out; an agent's `#b08850` planks still read as that color (compare the
mean albedo of a lit plank face before and after).

## Phase 8: vegetation

All tiers.

- **Grass.** Blade normals fan across the blade's width so each blade has a lit and a shaded side; a
  faint specular sheen on gust-flattened blades; clumping (height and color vary together at the 2-4
  block scale so the meadow has tufts and thin patches); taller, seed-headed blades in the drier
  patches; flowers in drifts rather than uniform chance. Keep the blade count and the compact
  32-byte `Blade`.
- **Meadow floor.** The ground under the blades (the `grass` pattern's top face) gets the same clump
  and occlusion terms, so sparse far grass and the software tier's thin grass don't expose a flat
  green sheet.
- **Trees.** Bake a crown gradient into vertex color when `designs.ts` builds a template: darker
  toward the trunk and underside, lighter outside and on top. Per-instance hue and value jitter from
  position. Wind in three scales in `windOffset`: whole-tree lean with gusts (the same gust field
  the grass uses, so a wave crosses meadow and canopy together), branch sway, leaf flutter.
- **Crops and ground cover** read the field map and pushers like grass.

Acceptance: `morning-close` and `noon-wide` against baseline; grass count and software frame time
unchanged within noise.

## Phase 9: ambient life

`render/life.ts`: one instanced pipeline in `trans`, positions generated in the vertex shader from a
hash of a world cell and time, around the camera. No CPU particles, no sim state, nothing agents can
interact with. `?debug=life` skips it.

- Day: pollen and dust motes that light up inside shafts (sample the key light), butterflies over
  flower drifts, a few gulls circling high over the coast.
- Dusk and night: fireflies over the meadow near water (bloom picks them up), moths around lamps.
- Autumnal touch all day: the occasional leaf falling under a crown (field map r tells where crowns
  are).
- Water: fish rings, wading ripples (phase 6).
- Existing particles (`particles.ts`): soft-fade smoke and halos against scene depth so they don't
  cut into walls; light smoke by the key light and shadow.

Keep densities low; this is seasoning. Everything fades out within ~60 blocks.

Acceptance: a 20-second capture sequence at dusk shows motion with no agent in frame; nothing
visible pops in or out at the fade distance.

## Phase 10: night

All tiers; mostly `look.ts` and `post.ts`.

- Give moonlit scenes contrast: a stronger, cooler key against a darker ambient, so moon shadows
  read and silhouettes separate from the sky; keep the eyes-adjust exposure.
- Narrow the blanket blue grade (`mix(vec3f(0.6, 0.78, 1.3), …)` in `post.ts`) so foliage, sand, and
  water keep some separation; let lamplit areas stay fully warm against it.
- Moon phase drives the whole scene's level: a full moon is bright enough to see the island, a new
  moon is starlight and lamps.
- Lamps: warm pools with a visible falloff edge, window/doorway spill from the light field, halos
  through the shafts pass.
- Check `night-moon` and `night-lamps` on a dim display setting too; night must stay playable for
  spectators.

Acceptance: `night-moon` shows distinct lit and shadowed sides on trees and hills; `night-lamps`
looks like a warm village in a cool landscape.

## Phase 11: post

- **Bloom.** Replace the 4-tap box with a 13-tap downsample (Karis average on the first level) and a
  9-tap tent upsample: no flicker from single glinting pixels, a rounder glow. Same level count.
- **Composite order:** scene × AO → + shafts → + bloom → exposure → tonemap → grade → sharpen →
  vignette → dither.
- **Grade.** Per-look shadow and highlight tints applied as a small split-tone after the tonemap
  (cool shade, warm light), tuned low in Natural so Material colors stay true; stronger in
  Storybook.
- **Tilt-shift depth of field** as a look option only (off in Natural; on in Storybook at far
  orbit), using the half-res depth. Ask Ethan before enabling it anywhere by default.
- Revisit the `GAIN`, bloom, and sharpen constants once everything above is in; AO and shafts shift
  the overall level.

## Phase 12: wrap-up

- Re-tune all four looks against the shot set; `look_test.ts` covers any new `Look` fields.
- Spectator panel: quality selector next to the look selector.
- `docs/DESIGN.md` art direction and performance budgets, `CLAUDE.md` code map and URL params
  (`quality`, new `debug` names), and the uniform-layout note (frame group binding 5, the scene
  group).
- `docs/playtests/0013-visual-overhaul.md` with before/after pictures and the software frame times
  per tier; new `docs/media/screenshot-island.webp` and `web/og.jpg` if Ethan wants them.
- Hand Ethan the hardware checklist below.

## Tiers

| Feature                                        | low | medium        | high  |
| ---------------------------------------------- | --- | ------------- | ----- |
| Field map, pushers, surfaces, vegetation, life | yes | yes           | yes   |
| Sky, night, bloom filter, grade                | yes | yes           | yes   |
| Shadow cascade 1                               | yes | yes           | yes   |
| Opaque/trans split, scene depth                | no  | yes           | yes   |
| GTAO                                           | no  | 2 × 4         | 3 × 6 |
| Shafts and lamp glow                           | no  | 8 steps       | 16    |
| Water refraction, soft shore                   | no  | yes           | yes   |
| Water SSR                                      | no  | if affordable | yes   |
| Cloud slab                                     | no  | no            | yes   |

## Budget

Shaded-pixel reasoning at 1080p (2.07 M pixels), to be confirmed on hardware:

| Pass                | Pixels            | Work per pixel                 |
| ------------------- | ----------------- | ------------------------------ |
| MSAA store + reload | full, 4 samples   | bandwidth only                 |
| Depth downsample    | 1/4               | 4 loads                        |
| GTAO + blur         | 1/4               | 8-18 depth taps + 16 blur taps |
| Shafts              | 1/16              | 8-16 shadow taps + light field |
| Cloud slab          | ≤ 1/4 (sky only)  | ~12 × (2 noise) + 3 light      |
| Water SSR           | water pixels only | 12-16 depth taps               |
| Bloom filter        | ~1/6              | 13 and 9 taps instead of 4     |
| Cascade 1           | 2048², amortized  | terrain + low flora            |

Target on an integrated GPU at medium: the whole frame under 14 ms at 1080p, with the adaptive
governor dropping to low-tier passes before it drops resolution. Target at high on a discrete GPU:
under 5 ms.

Hardware checklist for Ethan (the agent can't run these): `deno task shot` at each of
`?quality=low|medium|high`, then `?debug=` each of `ao`, `shafts`, `clouds`, `life`, `bloom`,
`water` at high, recording `gpuMs`; the same on the integrated-GPU laptop at 1080p.

## Order, size, and what to ship when

Three PRs, each reviewable from pictures:

1. **Depth and grounding:** phases 0-3. The biggest visible step for the least risk; the field map
   and pushers alone change every shot.
2. **Air, sky, water:** phases 4-6. The cloud slab is the one item to prototype and confirm first.
3. **Surfaces and life:** phases 7-12.

Within a PR, one commit per phase, each leaving `deno task check` and `deno task test` green and the
shot set free of GPU errors. If time runs short, the order of value is: 2a/2b field map and pushers,
3 cascades, 4 shafts, 6 water, 10 night, 7 surfaces, 8 vegetation, 2c GTAO, 9 life, 11 post, 5b
cloud slab.

## Risks

- **MSAA + sampled depth.** Sample 0 of a multisampled depth is enough for AO, shafts, and SSR, but
  edges need care: upsample AO and shafts depth-aware or silhouettes get halos.
- **Software adapter.** Low tier must stay near today's frame time: agents' `screenshot` tool and
  `deno task host` run there. Measure after every phase with the shot set.
- **Captures.** `capture` renders at its own size into `shotTargets`; amortized state (cascade 1,
  the cloud target) must be valid for a capture taken right after a camera snap. Force a full update
  when `capture` is true.
- **Determinism of pictures.** Anything time-driven must take the frame's `time` (so a fixed `atMs`
  gives the same picture), never `performance.now()` inside a pass.
- **Frame group change.** Adding binding 5 touches every lit pipeline's layout at once, including
  the grass compute; change `Layouts.frame` and `frameBindGroup` together and run the whole shot
  set.
- **Art direction drift.** AO, shafts, grade, and DoF can all push the look away from "true colors".
  Tune each low in Natural and put the stronger versions in Lush and Storybook.

## Questions for Ethan before or during the work

1. Cloud slab: worth the cost over the PR #41 layer? (Decide from the prototype.)
2. Tilt-shift depth of field: Storybook only, or not at all?
3. Rain and wet weather as rendering when cloud cover is high (streaks, rings on water, glossy
   ground), or leave weather alone until the sim has rain?
4. Three PRs as above, or one long-running branch?
