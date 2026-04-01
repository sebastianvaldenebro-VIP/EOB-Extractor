import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PdfReadResult {
  readonly buffer: Buffer;
  readonly versionId: string;
}

export class PdfValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfValidationError';
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PDF_MAGIC_BYTES = Buffer.from('%PDF');
const MAX_PDF_SIZE_BYTES = 4.5 * 1024 * 1024; // 4.5 MB
const MAX_PAGE_COUNT = 100;
const SANITIZE_MAX_CHARS = 50_000;

const s3Client = new S3Client({});

// ---------------------------------------------------------------------------
// S3 PDF Reader
// ---------------------------------------------------------------------------

/**
 * Read a PDF from S3 and return the raw buffer plus version ID.
 * Version ID is critical for idempotent reprocessing and audit trail.
 */
export async function readPdf(bucket: string, key: string): Promise<PdfReadResult> {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const response = await s3Client.send(command);

  if (!response.Body) {
    throw new PdfValidationError(`S3 object body is empty: s3://${bucket}/${key}`);
  }

  const byteArray = await response.Body.transformToByteArray();
  const buffer = Buffer.from(byteArray);

  return {
    buffer,
    versionId: response.VersionId ?? '',
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a PDF buffer:
 * - Magic bytes: must start with %PDF
 * - Size: must be <= 4.5 MB (Bedrock document block limit)
 * - Page count: estimated <= 20 pages (heuristic)
 */
export function validatePdf(buffer: Buffer): void {
  // Magic bytes check
  if (buffer.length < 4 || !buffer.subarray(0, 4).equals(PDF_MAGIC_BYTES)) {
    throw new PdfValidationError('Invalid PDF: missing %PDF magic bytes');
  }

  // Size check
  if (buffer.length > MAX_PDF_SIZE_BYTES) {
    throw new PdfValidationError(
      `PDF exceeds maximum size: ${(buffer.length / (1024 * 1024)).toFixed(1)} MB > ${MAX_PDF_SIZE_BYTES / (1024 * 1024)} MB`,
    );
  }

  // Estimated page count via /Type /Page occurrences (heuristic, not exact)
  const content = buffer.toString('binary');
  const pageMatches = content.match(/\/Type\s*\/Page[^s]/g);
  const estimatedPages = pageMatches?.length ?? 0;

  if (estimatedPages > MAX_PAGE_COUNT) {
    throw new PdfValidationError(
      `PDF has too many pages: ~${estimatedPages} > ${MAX_PAGE_COUNT}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Key parsing
// ---------------------------------------------------------------------------

/**
 * Extract taskId from S3 key in format: clickup/{taskId}/filename.pdf
 * Returns null if the key does not match the expected pattern.
 */
export function extractTaskId(s3Key: string): string | null {
  const match = s3Key.match(/^clickup\/([^/]+)\//);
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Sanitization (ported from ENLO sanitizer.py)
// ---------------------------------------------------------------------------

/**
 * Sanitize text before embedding in a prompt.
 * Defends against prompt injection by neutralizing XML tags that could
 * break out of delimited context sections.
 *
 * - Removes null bytes
 * - Escapes XML closing tags to prevent breaking out of XML context
 * - Escapes XML opening tags that could inject new sections
 * - Truncates to 50k chars to prevent context overflow
 */
export function sanitizeForPrompt(text: string): string {
  if (!text) return '';

  let sanitized = text;

  // Remove null bytes
  sanitized = sanitized.replace(/\0/g, '');

  // Neutralize XML tag injection: replace < and > with safe representations.
  // Order matters: escape closing tags first, then opening tags, then >.
  sanitized = sanitized.replace(/<\//g, '[ENDTAG:');
  sanitized = sanitized.replace(/</g, '[TAG:');
  sanitized = sanitized.replace(/>/g, ':END]');

  // Truncate to prevent context overflow
  return sanitized.slice(0, SANITIZE_MAX_CHARS);
}
