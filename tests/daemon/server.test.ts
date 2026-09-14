import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { startServer } from "../../src/daemon/server.js";
import { TitleStore } from "../../src/core/store.js";
import type { TitleEngine } from "../../src/core/inference.js";
import { tempDir, cleanupTempDirs } from "../helpers/tmp.js";

/** Stub engine: the daemon's job is routing and I/O, not inference. */
const stubEngine = {
  backend: "stub",
  async generate(clip: string) {
    return { result: { title: `stub:${clip.slice(0, 10)}`, description: null }, backend: "stub" };
  },
  async dispose() {},
} as unknown as TitleEngine;

let socketPath: string;
let close: () => Promise<void>;

beforeEach(async () => {
  // Under <repo>/.tmp, not os.tmpdir(): this suite used to leave one directory
  // per test in the OS temp directory and never remove it (234 of them).
  const dir = await tempDir("daemon-");
  socketPath = process.platform === "win32" ? `\\\\.\\pipe\\qt-test-${Date.now()}` : join(dir, "d.sock");
  const store = new TitleStore(join(dir, "titles.jsonl"));
  ({ close } = await startServer({ socketPath, engine: stubEngine, store }));
});

afterEach(async () => {
  // Close the server first: on unix the socket lives in the directory being
  // removed, and on Windows the pipe is independent of it either way.
  await close();
  cleanupTempDirs();
});

function call(payload: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket: Socket = createConnection(socketPath);
    let buffer = "";
    socket.on("connect", () => socket.write(JSON.stringify(payload) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      resolve(JSON.parse(buffer.slice(0, nl)));
      socket.end();
    });
    socket.on("error", reject);
  });
}

describe("daemon server", () => {
  it("answers ping", async () => {
    const res = await call({ id: "1", method: "ping" });
    expect(res.ok).toBe(true);
  });

  it("reports status", async () => {
    const res = await call({ id: "2", method: "status" });
    expect(res.result.backend).toBe("stub");
    expect(res.result.version).toBe(1);
  });

  it("rejects an unknown method without crashing", async () => {
    const res = await call({ id: "3", method: "nope" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unknown method/);
  });

  it("rejects malformed JSON without crashing", async () => {
    const res = await new Promise<any>((resolve, reject) => {
      const socket = createConnection(socketPath);
      let buffer = "";
      socket.on("connect", () => socket.write("not json\n"));
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        const nl = buffer.indexOf("\n");
        if (nl === -1) return;
        resolve(JSON.parse(buffer.slice(0, nl)));
        socket.end();
      });
      socket.on("error", reject);
    });
    expect(res.ok).toBe(false);
  });

  it("generates and persists a title", async () => {
    const res = await call({
      id: "4",
      method: "generate",
      params: { agent: "pi", sessionId: "s1", transcriptPath: "tests/fixtures/sessions/pi.jsonl" },
    });
    expect(res.ok).toBe(true);
    expect(res.result.title).toMatch(/^stub:/);
    expect(res.result.description).toBeNull();
  });

  it("lists stored titles", async () => {
    await call({
      id: "5",
      method: "generate",
      params: { agent: "pi", sessionId: "s2", transcriptPath: "tests/fixtures/sessions/pi.jsonl" },
    });
    const res = await call({ id: "6", method: "list", params: { agent: "pi" } });
    expect(res.result.length).toBeGreaterThan(0);
  });
});
