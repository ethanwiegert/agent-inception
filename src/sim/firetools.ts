import { FIRE_LIMITS, type Target } from "./fire.ts";
import { areaArgs, type Handler, MAX_AREA, num, reach, work } from "./jobs.ts";
import { Anim, type Sim } from "./sim.ts";
import type { ToolDef } from "./tools.ts";

/**
 * Fire for agents: `ignite` sets something alight, `douse` puts fires out. Neither needs a tool
 * item (like `interact`). What burns, how fire spreads and its caps are in fire.ts.
 */

const int = (description: string) => ({ type: "integer", description });

export const FIRE_TOOL_DEFS: ToolDef[] = [
  {
    name: "ignite",
    description: "Set something alight at (x, z): an Object there, a tree or plant, a crop, or " +
      "the top block (or the block at height y). Only things made mostly of Materials that burn " +
      "catch (logs, planks, thatch, trees, wheat, wool; never grass, dirt, sand or stone). Fire " +
      "spreads slowly to touching things that burn and burns them away for good; douse puts it " +
      `out, and so does heavy cloud. At most ${FIRE_LIMITS.burning} things burn at once, and ` +
      `one fire burns at most ${FIRE_LIMITS.perFire}. You walk within reach first. Nobody is ` +
      "ever hurt: villagers step out of flames, animals run. For a fire that never spreads, " +
      "build a Design with a flame part (a torch, a campfire).",
    inputSchema: {
      type: "object",
      properties: {
        x: int("Tile x."),
        z: int("Tile z."),
        y: int("A block's height, to light that block instead of what's on top."),
      },
      required: ["x", "z"],
    },
  },
  {
    name: "douse",
    description: "Put out fires over an area (width × depth tiles, at most 16): you walk to each " +
      "burning thing and beat it out, about a second each. Whatever had burnt is gone; what " +
      "was still burning stays as it is. Tame flames (torches, campfires) aren't wild fire: " +
      "use puts those out.",
    inputSchema: {
      type: "object",
      properties: {
        x: int("West edge of the area (x grows east)."),
        z: int("North edge of the area (z grows south)."),
        width: { ...int("Tiles along x, default 1."), minimum: 1, maximum: MAX_AREA },
        depth: { ...int("Tiles along z, default 1."), minimum: 1, maximum: MAX_AREA },
      },
      required: ["x", "z"],
    },
  },
];

/** Burning things near (x, z) for `look`, nearest first. */
export function fireText(sim: Sim, x: number, z: number, r: number): string[] {
  const fire = sim.wildfire;
  const near = [...fire.burning.values()]
    .map((b) => {
      const [x0, x1, , , z0, z1] = fire.box(b);
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      return { b, cx, cz, d: Math.hypot(cx - x, cz - z) };
    })
    .filter((f) => f.d <= r)
    .sort((a, b) => a.d - b.d);
  if (!near.length) return [];
  const lines = near.slice(0, 8).map(({ b, cx, cz, d }) => {
    const [, y] = fire.place(b);
    const left = Math.max(1, Math.round((b.until - sim.tick) / 20));
    return `  ${fire.nameOf(b)} at x=${Math.floor(cx)} z=${Math.floor(cz)}${
      b.kind === "block" ? ` y=${y}` : ""
    } (${Math.round(d)} tile${Math.round(d) === 1 ? "" : "s"}; burnt through in ~${left} s)`;
  });
  if (near.length > 8) lines.push(`  …and ${near.length - 8} more`);
  return lines;
}

export const FIRE_HANDLERS: Record<string, Handler> = {
  ignite(sim, agent, args) {
    const x = num(args.x, "x"), z = num(args.z, "z");
    const y = args.y === undefined || args.y === null ? undefined : num(args.y, "y");
    const w = sim.world;
    if (w.heightAt(x, z) < 0) throw new Error(`(${x}, ${z}) is outside the world.`);
    const fire = sim.wildfire;
    const pick = (): Target | string => {
      const targets = fire.targetsAt(x, z, y);
      let why = "";
      for (const t of targets) {
        const no = fire.refusal(t);
        if (!no) return t;
        why ||= no;
      }
      return why || "there's nothing there to burn";
    };
    const first = pick();
    if (typeof first === "string" && first.includes("already burning")) {
      throw new Error(`${first[0].toUpperCase()}${first.slice(1)} at (${x}, ${z}).`);
    }
    if (typeof first === "string") {
      throw new Error(
        `Nothing at (${x}, ${z}) will catch: ${first}. Logs, planks, thatch, trees, crops and ` +
          "Objects made of them burn; grass, dirt, sand and stone don't.",
      );
    }
    if (fire.burning.size >= FIRE_LIMITS.burning) {
      throw new Error(
        `${FIRE_LIMITS.burning} things are burning already, as many as a world allows at once. ` +
          "Wait for some to burn out, or douse them.",
      );
    }
    return (function* () {
      yield* reach(sim, agent, x, z, y);
      yield* work(agent, Anim.Build, 20);
      const t = pick();
      if (typeof t === "string") throw new Error(`It won't catch now: ${t}.`);
      const why = fire.light(t, agent.name, false);
      if (why) throw new Error(`It won't catch: ${why}.`);
      return `You set the ${t.name} at (${x}, ${z}) alight. Fire spreads slowly to touching ` +
        "things that burn and burns them away; douse puts it out (look lists what's burning). " +
        `${fire.burning.size} thing${fire.burning.size === 1 ? "" : "s"} burning in the world.`;
    })();
  },

  douse(sim, agent, args) {
    const { x0, z0, width, depth } = areaArgs(args);
    const fire = sim.wildfire;
    const inArea = () =>
      [...fire.burning].filter(([, b]) => {
        const [bx0, bx1, , , bz0, bz1] = fire.box(b);
        return bx1 > x0 && bx0 < x0 + width && bz1 > z0 && bz0 < z0 + depth;
      });
    if (!inArea().length) {
      const all = [...fire.burning.values()].map((b) => {
        const [bx0, bx1, , , bz0, bz1] = fire.box(b);
        const cx = (bx0 + bx1) / 2, cz = (bz0 + bz1) / 2;
        return { b, cx, cz, d: Math.hypot(cx - x0 - width / 2, cz - z0 - depth / 2) };
      }).sort((a, b) => a.d - b.d);
      const n = all[0];
      throw new Error(
        "Nothing is burning there." +
          (n
            ? ` The nearest fire is the ${fire.nameOf(n.b)} at x=${Math.floor(n.cx)} z=${
              Math.floor(n.cz)
            }.`
            : " Nothing is burning anywhere."),
      );
    }
    return (function* () {
      const put: string[] = [], unreachable = new Set<string>();
      for (let guard = 0; guard < 64; guard++) {
        // Nearest first: fire moves while you work.
        const left = inArea().filter(([k]) => !unreachable.has(k)).map(([k, b]) => {
          const [bx0, bx1, , , bz0, bz1] = fire.box(b);
          const cx = (bx0 + bx1) / 2, cz = (bz0 + bz1) / 2;
          return { k, b, cx, cz, d: Math.hypot(cx - agent.x, cz - agent.z) };
        }).sort((a, b) => a.d - b.d);
        if (!left.length) break;
        const { k, b, cx, cz } = left[0];
        const name = fire.nameOf(b);
        try {
          yield* reach(sim, agent, Math.floor(cx), Math.floor(cz));
        } catch {
          unreachable.add(k);
          continue;
        }
        yield* work(agent, Anim.Harvest, 16);
        if (fire.burning.has(k)) {
          fire.out(k);
          put.push(name);
        }
      }
      const still = inArea().length;
      return (put.length ? `You put out ${put.length}: ${put.join(", ")}.` : "The fire was out.") +
        (unreachable.size ? ` You couldn't get near ${unreachable.size} of them.` : "") +
        (still ? ` ${still} still burning in that area.` : "") +
        (fire.burning.size ? ` ${fire.burning.size} burning in the world (look lists them).` : "");
    })();
  },
};
