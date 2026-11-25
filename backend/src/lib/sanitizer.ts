/**
 * sanitizer.ts
 *
 * Content sanitization to prevent script injection attacks.
 * Removes or escapes HTML/script tags while preserving plain text and safe formatting.
 */

import DOMPurify from "isomorphic-dompurify";
import { sanitizeText } from "./sanitize";

/**
 * Sanitize a chat message body to prevent script injection.
 * Strips all HTML tags and script content, returning plain text.
 *
 * @param body - The message body to sanitize
 * @returns Sanitized plain text
 */
export function sanitizeMessageBody(body: string): string {
  if (!body || typeof body !== "string") {
    return "";
  }

  // Strip all HTML tags and return plain text content
  // ALLOWED_TAGS: [] ensures no HTML tags are preserved, only text content
  const cleaned = DOMPurify.sanitize(body, { ALLOWED_TAGS: [] });

  // Trim and return
  return cleaned.trim();
}

/**
 * Validate that a string looks like a URL (basic check).
 * Used to detect potential malicious links like javascript:alert(1).
 *
 * @param text - The text to check
 * @returns true if the text contains a dangerous protocol
 */
export function containsDangerousProtocol(text: string): boolean {
  // Match dangerous protocols: javascript:, data:, vbscript:, etc.
  const dangerousProtocols = /^(javascript|data|vbscript|file|about|blob):/i;
  return dangerousProtocols.test(text);
}

/**
 * Sanitize and validate a message body for security.
 * Removes scripts, HTML tags, and dangerous protocols.
 *
 * @param body - The raw message body
 * @returns Sanitized body safe for storage and display
 */
export function validateAndSanitizeMessageBody(body: string): string {
  // First, sanitize HTML/script tags
  let sanitized = sanitizeMessageBody(body);

  // Check for dangerous protocols in URLs
  if (containsDangerousProtocol(sanitized)) {
    // Remove the dangerous part
    sanitized = sanitized.replace(/^(javascript|data|vbscript|file|about|blob):.*/i, "");
  }

  return sanitized;
}

const MAX_DELIVERABLE_BYTES = 5 * 1024 * 1024;
export const MAX_DELIVERABLE_DATA_URL_LENGTH = 4 * Math.ceil(MAX_DELIVERABLE_BYTES / 3) + 64;

const formats = {
  "application/pdf": { extensions: /\.pdf$/i, headers: ["255044462d"] },
  "image/png": { extensions: /\.png$/i, headers: ["89504e470d0a1a0a"] },
  "image/jpeg": { extensions: /\.jpe?g$/i, headers: ["ffd8ff"] },
  "application/zip": { extensions: /\.zip$/i, headers: ["504b0304", "504b0506"] },
};

function canonicalMime(type: string) {
  return type.toLowerCase() === "application/x-zip-compressed"
    ? "application/zip"
    : type.toLowerCase();
}

export function sanitizeDeliverable(input: {
  fileUrl: string;
  fileName: string;
  fileType?: string;
  fileSize?: number;
  description?: string;
}) {
  const dataUrl = /^data:([a-z/+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(input.fileUrl);
  if (!dataUrl || dataUrl[2].length % 4 !== 0) return undefined;

  const fileType = canonicalMime(dataUrl[1]);
  if (!Object.prototype.hasOwnProperty.call(formats, fileType)) return undefined;
  const format = formats[fileType as keyof typeof formats];
  const fileName = sanitizeText(input.fileName);
  if (!format.extensions.test(fileName) || /[\\/]/.test(fileName)) return undefined;
  if (input.fileType && canonicalMime(input.fileType) !== fileType) return undefined;

  const bytes = Buffer.from(dataUrl[2], "base64");
  const header = bytes.subarray(0, 8).toString("hex");
  if (
    bytes.length > MAX_DELIVERABLE_BYTES ||
    (input.fileSize !== undefined && bytes.length !== input.fileSize) ||
    !format.headers.some((signature) => header.startsWith(signature))
  ) return undefined;

  return {
    fileName,
    fileType,
    fileSize: bytes.length,
    fileUrl: `data:${fileType};base64,${bytes.toString("base64")}`,
    description: input.description === undefined ? undefined : sanitizeText(input.description),
  };
}
