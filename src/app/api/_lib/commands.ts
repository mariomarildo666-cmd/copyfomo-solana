// Owner commands (withdraw / close_all) are queued as Command rows; only the worker executes them.

import type { Command } from "@prisma/client";
import { toCommandDTO } from "@/lib/agents";
import { prisma } from "@/lib/db";
import { HttpError, json } from "@/lib/http";
import type { ApiError, CommandConflictDTO, CommandType } from "@/lib/types";

export type WithdrawPayload =
  | { amountSol: number; closePositions: boolean }
  | { all: true; closePositions: boolean };

export type ClosePayload = Record<string, never>;

const OPEN_STATUSES = ["pending", "running"];

/** 409 body when a command of the same type is still open (lib/types CommandConflictDTO); re-exported here. */
export type { CommandConflictDTO };

/** Another command of this type is still pending/running (finding F39: the 409 names it). */
export class CommandConflictError extends HttpError {
  readonly command: Command | null;
  constructor(message: string, command: Command | null) {
    super(409, message);
    this.name = "CommandConflictError";
    this.command = command;
  }

  toResponse(): Response {
    if (!this.command) return json<ApiError>({ error: this.message }, { status: 409, headers: { "cache-control": "no-store" } });
    return json<CommandConflictDTO>(
      { error: this.message, command: toCommandDTO(this.command) },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  }
}

// Per-process guard so two concurrent requests can't both pass the "nothing open yet" check.
// (Single web instance assumed, like ratelimit.ts; a multi-instance deploy also needs a DB-level guard.)
const globalForCmd = globalThis as unknown as { __copyfomoCmdLocks?: Set<string> };
const locks = (globalForCmd.__copyfomoCmdLocks ??= new Set<string>());

/**
 * Insert a pending Command. With `exclusive`, refuse (CommandConflictError, 409, carrying the open command)
 * while another command of the same type for this agent is still pending or running.
 */
export async function enqueueCommand(
  agentId: string,
  type: CommandType,
  payload: WithdrawPayload | ClosePayload,
  exclusive?: { conflictMessage: string },
): Promise<Command> {
  const create = () => prisma.command.create({ data: { agentId, type, payload: JSON.stringify(payload) } });
  if (!exclusive) return create();

  const key = `${agentId}:${type}`;
  if (locks.has(key)) throw new CommandConflictError(exclusive.conflictMessage, await openCommand(agentId, type));
  locks.add(key);
  try {
    const open = await openCommand(agentId, type);
    if (open) throw new CommandConflictError(exclusive.conflictMessage, open);
    return await create();
  } finally {
    locks.delete(key);
  }
}

function openCommand(agentId: string, type: CommandType): Promise<Command | null> {
  return prisma.command.findFirst({
    where: { agentId, type, status: { in: OPEN_STATUSES } },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * The agent's newest commands (owner only: results carry amounts, signatures and errors). Open commands come
 * first so a reloaded dashboard can resume polling the one in flight (finding F39).
 */
export async function recentCommands(agentId: string, opts: { type?: CommandType; limit: number }): Promise<Command[]> {
  const where = { agentId, ...(opts.type ? { type: opts.type } : {}) };
  const [open, recent] = await Promise.all([
    prisma.command.findMany({ where: { ...where, status: { in: OPEN_STATUSES } }, orderBy: { createdAt: "desc" }, take: opts.limit }),
    prisma.command.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: opts.limit }),
  ]);
  const seen = new Set<string>();
  const out: Command[] = [];
  for (const c of [...open, ...recent]) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out.slice(0, opts.limit);
}
