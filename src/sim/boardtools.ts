import { BOARD_LIMITS } from "./board.ts";
import type { Handler } from "./jobs.ts";
import type { ToolDef } from "./tools.ts";

/** The Notice Board for agents: read spectators' Wishes, reply to them, mark them done. */

export const BOARD_TOOL_DEFS: ToolDef[] = [
  {
    name: "board",
    description: "The Notice Board, where the people watching pin Wishes: short suggestions for " +
      "anyone or for one villager. A Wish is never an order and earns nothing; take one up if " +
      "you like it. action list (default) shows the board; reply answers a Wish by id with text " +
      `(at most ${BOARD_LIMITS.perVillager} replies each); done marks it done (only the villager ` +
      "it's meant for, if it names one), with an optional note.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "reply", "done"] },
        id: { type: "integer", description: "The Wish's number, as the board lists it." },
        text: {
          type: "string",
          maxLength: BOARD_LIMITS.text,
          description: "Your reply, or a note when marking it done.",
        },
      },
    },
  },
];

export const BOARD_HANDLERS: Record<string, Handler> = {
  board(sim, agent, args) {
    const action = args.action ?? "list";
    const board = sim.board;
    if (action === "list") {
      if (args.id !== undefined || args.text !== undefined) {
        throw new Error("list takes no id or text; reply or done do.");
      }
      return board.text(agent);
    }
    if (action === "reply") return board.reply(agent, args.id, args.text);
    if (action === "done") return board.done(agent, args.id, args.text);
    throw new Error(`action is list, reply or done, not ${JSON.stringify(action)}.`);
  },
};
