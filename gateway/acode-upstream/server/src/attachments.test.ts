import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { maxAttachmentBase64Chars, maxAttachmentBytes, storeAttachments } from "./attachments.js";

test("attachment input rejects malformed base64 before writing", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "codeharbor-attachment-"));
  try {
    await assert.rejects(
      storeAttachments({ cwd, threadId: "00000000-0000-4000-8000-000000000000", attachments: [{ name: "a.txt", dataBase64: "%%%" }] }),
      (error: unknown) => error instanceof Error && error.message === "invalid_attachment"
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("attachment limits are bounded before decode", () => {
  assert.equal(maxAttachmentBytes, 15 * 1024 * 1024);
  assert.ok(maxAttachmentBase64Chars < 21 * 1024 * 1024);
});
