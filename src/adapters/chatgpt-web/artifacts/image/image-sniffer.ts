import { Buffer } from "node:buffer";
import type { OutputImageMime } from "../types";

export function sniffImageMime(bytes: Uint8Array): OutputImageMime | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  if (bytes.length >= 6 && (String.fromCharCode(...bytes.slice(0, 6)) === "GIF87a"
    || String.fromCharCode(...bytes.slice(0, 6)) === "GIF89a")) return "image/gif";
  return undefined;
}

export function extensionForImageMime(mime: OutputImageMime): "png" | "jpg" | "webp" | "gif" {
  switch (mime) { case "image/png": return "png"; case "image/jpeg": return "jpg"; case "image/webp": return "webp"; case "image/gif": return "gif"; }
}

export function imageDimensions(bytes: Buffer, mime: OutputImageMime): { width?: number; height?: number } {
  if (mime === "image/png" && bytes.length >= 24) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (mime === "image/gif" && bytes.length >= 10) return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (mime === "image/webp" && bytes.length >= 30 && String.fromCharCode(...bytes.slice(12, 16)) === "VP8X") {
    return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
  }
  return {};
}
