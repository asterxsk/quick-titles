import { createServer, type Server } from "node:net";
import { unlink } from "node:fs/promises";
import type { TitleEngine } from "../core/inference.js";
import type { TitleStore } from "../core/store.js";
import type { AgentId, TitleRecord } from "../core/types.js";
import { readClip } from "../core/session/index.js";
import { PROTOCOL_VERSION, type Request, type Response, type StatusResult } from "./protocol.js";

const MODEL_VERSION = "title-q8_0@v0.1.0";

export interface StartServerOptions {
  socketPath: string;
  engine: TitleEngine;
  store: TitleStore;
}

async function handle(
  request: Request,
  engine: TitleEngine,
  store: TitleStore,
  startedAt: number
): Promise<unknown> {
  switch (request.method) {
    case "ping":
      return "pong";

    case "status":
      return {
        version: PROTOCOL_VERSION,
        backend: engine.backend,
        modelVersion: MODEL_VERSION,
        pid: process.pid,
        uptimeMs: Date.now() - startedAt,
      } satisfies StatusResult;

    case "generate": {
      const { agent, sessionId, transcriptPath } = request.params;
      const clip = await readClip(agent as AgentId, transcriptPath);
      if (!clip) return { title: null, description: null };
      const { result, backend } = await engine.generate(clip);
      if (result.title) {
        const record: TitleRecord = {
          agent: agent as AgentId,
          sessionId,
          title: result.title,
          description: result.description,
          backend,
          modelVersion: MODEL_VERSION,
          createdAt: new Date().toISOString(),
        };
        await store.append(record);
      }
      return result;
    }

    case "list":
      return store.list(request.params ?? {});

    case "shutdown":
      setImmediate(() => process.kill(process.pid, "SIGTERM"));
      return "shutting down";

    default:
      throw new Error(`unknown method: ${(request as { method: string }).method}`);
  }
}

export async function startServer(
  opts: StartServerOptions
): Promise<{ close(): Promise<void> }> {
  const startedAt = Date.now();

  const server: Server = createServer((socket) => {
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let response: Response;
        const id = (() => {
          try {
            return String(JSON.parse(line).id ?? "");
          } catch {
            return "";
          }
        })();
        try {
          const request = JSON.parse(line) as Request;
          response = { id, ok: true, result: await handle(request, opts.engine, opts.store, startedAt) };
        } catch (error) {
          response = { id, ok: false, error: (error as Error).message };
        }
        socket.write(JSON.stringify(response) + "\n");
      }
    });
    // A client disconnecting mid-request must not take the daemon down.
    socket.on("error", () => {});
  });

  if (process.platform !== "win32") {
    await unlink(opts.socketPath).catch(() => {});
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.socketPath, () => resolve());
  });

  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          if (process.platform !== "win32") unlink(opts.socketPath).catch(() => {});
          resolve();
        });
      }),
  };
}
