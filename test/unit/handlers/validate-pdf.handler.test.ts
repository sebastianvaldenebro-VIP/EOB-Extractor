import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock audit-logger to prevent console noise and avoid side-effects
vi.mock('../../../src/infrastructure/logging/audit-logger', () => ({
  logEvent: vi.fn(),
  logError: vi.fn(),
}));

// Import handler AFTER mocks are established
const { createHandler } = await import('../../../src/handlers/validate-pdf.handler');
// El mock de arriba tiene que traerse al scope del test para poder asertar sobre
// el. Sin esto, `logError` queda undefined y el test falla con ReferenceError.
const { logError } = await import('../../../src/infrastructure/logging/audit-logger');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal buffer that passes validatePdf: %PDF magic bytes, small, one page. */
function validPdfBuffer(): Buffer {
  return Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF');
}

function invalidPdfBuffer(): Buffer {
  return Buffer.from('this is not a pdf');
}

function buildDeps(buffer: Buffer = validPdfBuffer()) {
  return {
    readPdf: vi.fn().mockResolvedValue({ buffer, versionId: 'v1' }),
    quarantineFile: vi.fn().mockResolvedValue(undefined),
  };
}

const INPUT = {
  bucket: 'bucket-specialops-sandbox',
  key: 'clickup/TASK-100/eob.pdf',
  taskId: 'TASK-100',
  correlationId: 'corr-test-001',
} as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validate-pdf handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('valid PDF', () => {
    it('returns valid=true with passthrough fields, versionId and size', async () => {
      const deps = buildDeps();
      const handler = createHandler(deps);

      const result = await handler(INPUT);

      expect(deps.readPdf).toHaveBeenCalledWith(INPUT.bucket, INPUT.key);
      expect(result).toEqual({
        valid: true,
        bucket: INPUT.bucket,
        key: INPUT.key,
        taskId: INPUT.taskId,
        correlationId: INPUT.correlationId,
        versionId: 'v1',
        sizeBytes: validPdfBuffer().length,
      });
      expect(deps.quarantineFile).not.toHaveBeenCalled();
    });
  });

  describe('invalid PDF — quarantine path', () => {
    it('quarantines the file under quarantine/{key} and returns valid=false with reason', async () => {
      const deps = buildDeps(invalidPdfBuffer());
      const handler = createHandler(deps);

      const result = await handler(INPUT);

      expect(deps.quarantineFile).toHaveBeenCalledWith(
        INPUT.bucket,
        INPUT.key,
        `quarantine/${INPUT.key}`,
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/magic bytes/);
      // Invalid result must not leak passthrough processing fields
      expect(result.bucket).toBeUndefined();
      expect(result.versionId).toBeUndefined();
    });

    it('quarantines oversized PDFs (> 4.5 MB)', async () => {
      const oversized = Buffer.concat([
        Buffer.from('%PDF-1.4\n'),
        Buffer.alloc(5 * 1024 * 1024, 0x20),
      ]);
      const deps = buildDeps(oversized);
      const handler = createHandler(deps);

      const result = await handler(INPUT);

      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/maximum size/);
      expect(deps.quarantineFile).toHaveBeenCalledTimes(1);
    });

    it('quarantines PDFs with too many estimated pages', async () => {
      // MAX_PAGE_COUNT es 100 en s3-pdf-reader.ts, asi que hay que pasarlo.
      // Este test usaba 25 y por eso no cuarentenaba: 25 < 100, la validacion
      // pasaba correctamente. (Ojo: el comentario del modulo dice "<= 20",
      // que no coincide con la constante.)
      const manyPages = Buffer.from(
        '%PDF-1.4\n' + '<< /Type /Page >>\n'.repeat(101) + '%%EOF',
      );
      const deps = buildDeps(manyPages);
      const handler = createHandler(deps);

      const result = await handler(INPUT);

      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/too many pages/);
      expect(deps.quarantineFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('error paths', () => {
    it('rethrows and logs non-validation errors from readPdf without quarantining', async () => {
      const deps = buildDeps();
      deps.readPdf.mockRejectedValue(new Error('S3 access denied'));
      const handler = createHandler(deps);

      await expect(handler(INPUT)).rejects.toThrow('S3 access denied');
      expect(deps.quarantineFile).not.toHaveBeenCalled();
      expect(logError).toHaveBeenCalledWith(expect.objectContaining({
        correlationId: INPUT.correlationId,
        errorMessage: 'S3 access denied',
      }));
    });

    it('propagates a quarantine copy failure', async () => {
      const deps = buildDeps(invalidPdfBuffer());
      deps.quarantineFile.mockRejectedValue(new Error('CopyObject failed'));
      const handler = createHandler(deps);

      await expect(handler(INPUT)).rejects.toThrow('CopyObject failed');
    });
  });
});
