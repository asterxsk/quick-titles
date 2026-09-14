import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { TitleStore } from "../../src/core/store.js";
import type { TitleRecord } from "../../src/core/types.js";
import { tempDir, cleanupTempDirs } from "../helpers/tmp.js";

const record = (over: Partial<TitleRecord> = {}): TitleRecord => ({
  agent: "claude-code",
  sessionId: "s1",
  title: "Auth refactor",
  description: "Reworked token expiry.",
  backend: "vulkan",
  modelVersion: "title-q8_0@v0.1.0",
  createdAt: "2026-09-14T10:00:00.000Z",
  ...over,
});

let store: TitleStore;

beforeEach(async () => {
  // Under <repo>/.tmp, not os.tmpdir(): this suite used to leave one directory
  // per test in the OS temp directory and never remove it (282 of them).
  const dir = await tempDir("store-");
  store = new TitleStore(join(dir, "titles.jsonl"));
});

afterEach(cleanupTempDirs);

describe("TitleStore", () => {
  it("returns null for an unknown session", async () => {
    expect(await store.get("claude-code", "nope")).toBeNull();
  });

  it("round-trips a record", async () => {
    await store.append(record());
    expect((await store.get("claude-code", "s1"))?.title).toBe("Auth refactor");
  });

  it("last write wins", async () => {
    await store.append(record({ title: "First" }));
    await store.append(record({ title: "Second" }));
    expect((await store.get("claude-code", "s1"))?.title).toBe("Second");
  });

  it("does not confuse the same session id across agents", async () => {
    await store.append(record({ agent: "claude-code", title: "From Claude" }));
    await store.append(record({ agent: "pi", title: "From Pi" }));
    expect((await store.get("claude-code", "s1"))?.title).toBe("From Claude");
    expect((await store.get("pi", "s1"))?.title).toBe("From Pi");
  });

  it("lists newest first and honours the limit", async () => {
    await store.append(record({ sessionId: "a", createdAt: "2026-09-14T10:00:00.000Z" }));
    await store.append(record({ sessionId: "b", createdAt: "2026-09-14T11:00:00.000Z" }));
    const listed = await store.list({ limit: 1 });
    expect(listed).toHaveLength(1);
    expect(listed[0]!.sessionId).toBe("b");
  });

  it("survives a corrupt line in the file", async () => {
    await store.append(record());
    await store.append(record({ sessionId: "c" }));
    const { appendFile } = await import("node:fs/promises");
    await appendFile(store.filePath, "{not json}\n");
    expect(await store.get("claude-code", "s1")).not.toBeNull();
  });
});
