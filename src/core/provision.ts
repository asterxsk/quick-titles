// One-time model provisioning.
//
// The model is a ~380 MB GGUF converted from `desert-ant-labs/title`. It is not
// committed to this repository — the weights are covered by Desert Ant Labs'
// Source-Available License 1.0 and are not ours to redistribute without a
// decision by the maintainer — and it is far too large to fetch on the path of a
// hook that the host gives 25 seconds to finish. So it is fetched exactly once,
// ahead of time, by `quick-titles install` or `quick-titles provision`, and every
// later run is offline.
//
// Two things follow from that, and they are the reason this module is explicit
// about failure rather than best-effort:
//
//   * Nothing here ever runs during a title request. `client.ts` asks only
//     whether the file exists.
//   * A download that cannot be verified is not a download. The bytes are
//     streamed to `<model>.part`, hashed as they arrive, and only renamed into
//     place once the digest matches, so a truncated or corrupted transfer can
//     never be mistaken for a provisioned model.

import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { envPathOverride, modelPath } from "../paths.js";

/** Where the converted weights are published, and the digest they must have.
 *
 *  Both are empty until a release artifact exists. That is deliberate rather
 *  than an oversight: the repository is private and the weights derive from a
 *  source-available model, so the decision to host them has not been made. While
 *  these are empty, provisioning fails with an actionable message instead of
 *  guessing at a URL, and `QT_MODEL` remains the supported way to run against an
 *  already-converted file. */
export const MODEL_URL = "";
export const MODEL_SHA256 = "";

/** The digest and size to expect. `QUICK_TITLES_MODEL_SHA256` and
 *  `QUICK_TITLES_MODEL_URL` override the constants, which is what lets the test
 *  suite point provisioning at a fixture server. */
export function modelSource(): { url: string | undefined; sha256: string | undefined } {
  return {
    url: envPathOverride("QUICK_TITLES_MODEL_URL") ?? (MODEL_URL || undefined),
    sha256: envPathOverride("QUICK_TITLES_MODEL_SHA256") ?? (MODEL_SHA256 || undefined),
  };
}

/** What `doctor` needs to know about the model, without loading it. */
export interface ModelStatus {
  path: string;
  present: boolean;
  bytes: number;
  sourceConfigured: boolean;
}

export function modelStatus(): ModelStatus {
  const path = modelPath();
  const { url } = modelSource();
  try {
    const info = statSync(path);
    return { path, present: info.isFile(), bytes: info.size, sourceConfigured: url !== undefined };
  } catch {
    return { path, present: false, bytes: 0, sourceConfigured: url !== undefined };
  }
}

export interface ProvisionOptions {
  url?: string;
  sha256?: string;
  dest?: string;
  /** Called as bytes arrive. `total` is null when the server sends no
   *  `Content-Length`; the caller should degrade to a spinner, not a percentage. */
  onProgress?: (received: number, total: number | null) => void;
}

export type ProvisionResult =
  | { ok: true; path: string; bytes: number; alreadyPresent: boolean }
  | { ok: false; reason: string };

/**
 * Ensures the model exists at `dest`, downloading and verifying it if not.
 *
 * Idempotent: a file already at `dest` is accepted as-is and no request is made.
 * Never throws for an expected failure — a network error, a bad digest, and a
 * missing configuration are all returned as `{ ok: false, reason }`, because the
 * caller is a CLI that needs to print the reason, not a stack trace.
 */
export async function provisionModel(opts: ProvisionOptions = {}): Promise<ProvisionResult> {
  const dest = opts.dest ?? modelPath();

  if (existsSync(dest)) {
    return { ok: true, path: dest, bytes: statSync(dest).size, alreadyPresent: true };
  }

  const source = modelSource();
  const url = opts.url ?? source.url;
  if (!url) {
    return {
      ok: false,
      reason:
        "no download source is configured for the model.\n" +
        "  This build has no published weights URL, so quick-titles cannot fetch one.\n" +
        "  Convert `desert-ant-labs/title` yourself and point QT_MODEL at the result,\n" +
        "  or set QUICK_TITLES_MODEL_URL and QUICK_TITLES_MODEL_SHA256.",
    };
  }

  const expected = opts.sha256 ?? source.sha256;
  if (!expected) {
    return {
      ok: false,
      reason:
        `refusing to download from ${url} without a checksum to verify it against.\n` +
        "  Set QUICK_TITLES_MODEL_SHA256 to the expected SHA-256 of the file.",
    };
  }

  mkdirSync(dirname(dest), { recursive: true });
  // The partial file is a sibling, so the final rename stays on one filesystem
  // and is therefore atomic.
  const part = `${dest}.part`;

  const digest = createHash("sha256");
  let received = 0;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return { ok: false, reason: `downloading the model failed: ${response.status} ${response.statusText}` };
    }
    if (!response.body) {
      return { ok: false, reason: "downloading the model failed: the response had no body" };
    }

    const declared = Number(response.headers.get("content-length"));
    const total = Number.isFinite(declared) && declared > 0 ? declared : null;

    const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    body.on("data", (chunk: Buffer) => {
      digest.update(chunk);
      received += chunk.length;
      opts.onProgress?.(received, total);
    });

    await pipeline(body, createWriteStream(part));

    const actual = digest.digest("hex");
    if (actual !== expected.toLowerCase()) {
      discard(part);
      return {
        ok: false,
        reason:
          `the downloaded model did not match its checksum.\n` +
          `  expected ${expected}\n` +
          `  actual   ${actual}\n` +
          `  The partial file was discarded; nothing was installed.`,
      };
    }

    renameSync(part, dest);
    return { ok: true, path: dest, bytes: received, alreadyPresent: false };
  } catch (error) {
    discard(part);
    return { ok: false, reason: `downloading the model failed: ${(error as Error).message}` };
  }
}

/** Removes a partial download. Best effort: leaving the file behind is not a
 *  failure the caller can act on, and it will be overwritten next time. */
function discard(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or never created.
  }
}
