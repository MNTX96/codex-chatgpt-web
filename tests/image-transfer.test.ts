import { expect, test } from "bun:test";
import { ImageTransferDeadline, ImageTransferError, redactImageTransferError } from "../src/adapters/chatgpt-web/image-transfer";

async function rejection(operation: Promise<unknown>): Promise<unknown> {
  try { await operation; } catch (error) { return error; }
  throw new Error("Expected transfer cancellation");
}

test("image transfer polling preserves the typed shared deadline failure", async () => {
  const budget = new ImageTransferDeadline(Date.now() + 30);
  try {
    expect(await rejection(budget.pause(500))).toMatchObject({ code: "image_transfer_timeout", stage: "deadline" });
  } finally { budget.dispose(); }
});

test("image transfer polling preserves the caller's cancellation reason", async () => {
  const parent = new AbortController();
  const reason = new Error("cancelled by caller");
  const budget = new ImageTransferDeadline(undefined, parent.signal);
  try {
    const outcome = rejection(budget.pause(5_000));
    parent.abort(reason);
    expect(await outcome).toBe(reason);
  } finally { budget.dispose(); }
});

test("image transfer observations stop on cancellation and consume late rejections", async () => {
  const parent = new AbortController();
  const reason = new ImageTransferError("image_transfer_cancelled", "test");
  const budget = new ImageTransferDeadline(undefined, parent.signal);
  let rejectLate!: (error: Error) => void;
  try {
    const late = new Promise<never>((_resolve, reject) => { rejectLate = reject; });
    const outcome = rejection(budget.observe(late));
    parent.abort(reason);
    expect(await outcome).toBe(reason);
    rejectLate(new Error("late browser observation failure"));
    await Promise.resolve();
  } finally { budget.dispose(); }
});

test("image transfer errors retain cause without logging credentials or image payloads", () => {
  const error = new ImageTransferError("image_download_click_failed", "click", {
    cause: new Error("Timeout 30000ms https://example.invalid/file?sig=private-signature\nCookie: private-cookie\ndata:image/png;base64," + "A".repeat(100)),
  });
  const redacted = JSON.stringify(redactImageTransferError(error));
  expect(redacted).toContain("image_download_click_failed");
  expect(redacted).toContain("Timeout 30000ms");
  for (const secret of ["private-signature", "private-cookie", "A".repeat(100), "https://"]) expect(redacted).not.toContain(secret);
});
