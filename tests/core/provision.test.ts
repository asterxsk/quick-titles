// Tests for model provisioning.
//
// These run against a real HTTP server on a loopback port rather than a stubbed
// `fetch`, because the parts of this module that can actually be wrong are the
// transport ones: whether the bytes that arrive are the bytes that were hashed,
// whether a truncated transfer is distinguishable from a complete one, and
// whether a failed attempt leaves anything behind that a later run would mistake
// for a working model. A mocked fetch would exercise none of that.
//
// No download ever leaves the machine, and nothing is written outside <repo>/.tmp.
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { provisionModel } from "../../src/core/provision.js";
import { tempDirSync, cleanupTempDirs } from "../helpers/tmp.js";

const PAYLOAD = Buffer.from("not really 380 MB of model weights, but the right shape\n".repeat(64));
const PAYLOAD_SHA = createHash("sha256").update(PAYLOAD).digest("hex");

interface Fixture {
  url: string;
  /** Requests the server actually received, so "made no request" is checkable. */
  hits: () => number;
  close: () => Promise<void>;
}

/** Serves `handler` on a loopback port for the duration of one test. */
async function serve(handler: Parameters<typeof createServer>[1]): Promise<Fixture> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/model.gguf`,
    hits: () => hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** `serve()` for the common case of handing back the whole payload. */
async function servePayload(payload = PAYLOAD): Promise<Fixture> {
  return serve((_req, res) => {
    hits++;
    res.writeHead(200, { "content-length": String(payload.length) });
    res.end(payload);
  });
}

let hits = 0;
const servers: Fixture[] = [];

async function fixture(payload = PAYLOAD): Promise<Fixture> {
  hits = 0;
  const f = await servePayload(payload);
  servers.push(f);
  return f;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  cleanupTempDirs();
});

describe("provisionModel", () => {
  it("downloads, verifies, and leaves the model at the destination", async () => {
    const f = await fixture();
    const dest = join(tempDirSync("qt-prov-"), "model.gguf");

    const result = await provisionModel({ url: f.url, sha256: PAYLOAD_SHA, dest });

    expect(result).toEqual({ ok: true, path: dest, bytes: PAYLOAD.length, alreadyPresent: false });
    expect(readFileSync(dest)).toEqual(PAYLOAD);
  });

  it("makes no request at all when the model is already there", async () => {
    const f = await fixture();
    const dest = join(tempDirSync("qt-prov-"), "model.gguf");
    writeFileSync(dest, "already local");

    const result = await provisionModel({ url: f.url, sha256: PAYLOAD_SHA, dest });

    expect(result).toMatchObject({ ok: true, alreadyPresent: true });
    expect(readFileSync(dest, "utf8")).toBe("already local");
    expect(f.hits()).toBe(0);
  });

  it("refuses a payload whose digest does not match, and installs nothing", async () => {
    const f = await fixture();
    const dir = tempDirSync("qt-prov-");
    const dest = join(dir, "model.gguf");

    const result = await provisionModel({
      url: f.url,
      sha256: createHash("sha256").update("something else").digest("hex"),
      dest,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("did not match its checksum");
    expect(existsSync(dest)).toBe(false);
    // A `.part` left behind would be picked up by a later run's directory scan
    // and read as a partial model. It must be gone.
    expect(readdirSync(dir)).toEqual([]);
  });

  it("discards the partial file when the transfer is cut short", async () => {
    const f = await serve((_req, res) => {
      hits++;
      res.writeHead(200, { "content-length": String(PAYLOAD.length) });
      res.write(PAYLOAD.subarray(0, 100));
      res.destroy();
    });
    servers.push(f);
    const dir = tempDirSync("qt-prov-");
    const dest = join(dir, "model.gguf");

    const result = await provisionModel({ url: f.url, sha256: PAYLOAD_SHA, dest });

    expect(result.ok).toBe(false);
    expect(existsSync(dest)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("reports a non-200 instead of writing the error body as a model", async () => {
    const f = await serve((_req, res) => {
      hits++;
      res.writeHead(404);
      res.end("no such model");
    });
    servers.push(f);
    const dir = tempDirSync("qt-prov-");
    const dest = join(dir, "model.gguf");

    const result = await provisionModel({ url: f.url, sha256: PAYLOAD_SHA, dest });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("404");
    expect(existsSync(dest)).toBe(false);
  });

  it("will not download from a URL it has no checksum for", async () => {
    const f = await fixture();
    const dest = join(tempDirSync("qt-prov-"), "model.gguf");

    const result = await provisionModel({ url: f.url, sha256: "", dest });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("without a checksum");
    expect(f.hits()).toBe(0);
  });

  it("explains what to do when no source is configured and nothing is local", async () => {
    const dest = join(tempDirSync("qt-prov-"), "model.gguf");

    const result = await provisionModel({ url: "", sha256: PAYLOAD_SHA, dest });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("no download source is configured");
      expect(result.reason).toContain("QT_MODEL");
    }
  });

  it("reports progress against the declared length", async () => {
    const f = await fixture();
    const dest = join(tempDirSync("qt-prov-"), "model.gguf");
    const seen: Array<{ received: number; total: number | null }> = [];

    await provisionModel({
      url: f.url,
      sha256: PAYLOAD_SHA,
      dest,
      onProgress: (received, total) => seen.push({ received, total }),
    });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toEqual({ received: PAYLOAD.length, total: PAYLOAD.length });
  });

  it("writes the model atomically, never exposing a partial file under the real name", async () => {
    // The rename is the point: a concurrent reader must never observe a
    // half-written model at the path the daemon loads.
    const f = await fixture();
    const dir = tempDirSync("qt-prov-");
    const dest = join(dir, "model.gguf");
    let sawPartialAtDest = false;

    const watcher = setInterval(() => {
      if (existsSync(dest) && statSync(dest).size !== PAYLOAD.length) sawPartialAtDest = true;
    }, 1);
    await provisionModel({ url: f.url, sha256: PAYLOAD_SHA, dest });
    clearInterval(watcher);

    expect(sawPartialAtDest).toBe(false);
    expect(statSync(dest).size).toBe(PAYLOAD.length);
  });
});
