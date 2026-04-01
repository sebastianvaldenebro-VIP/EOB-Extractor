import {
  validatePdf,
  extractTaskId,
  sanitizeForPrompt,
  PdfValidationError,
} from '../../../src/infrastructure/storage/s3-pdf-reader';

describe('validatePdf', () => {
  it('accepts a valid PDF buffer with %PDF header', () => {
    const pdfHeader = Buffer.from('%PDF-1.4 fake content');
    expect(() => validatePdf(pdfHeader)).not.toThrow();
  });

  it('rejects a non-PDF buffer', () => {
    const notPdf = Buffer.from('This is not a PDF');
    expect(() => validatePdf(notPdf)).toThrow(PdfValidationError);
    expect(() => validatePdf(notPdf)).toThrow('missing %PDF magic bytes');
  });

  it('rejects an empty buffer', () => {
    expect(() => validatePdf(Buffer.alloc(0))).toThrow(PdfValidationError);
  });

  it('rejects a buffer shorter than 4 bytes', () => {
    expect(() => validatePdf(Buffer.from('%PD'))).toThrow(PdfValidationError);
  });

  it('rejects an oversized buffer (>4.5MB)', () => {
    const oversized = Buffer.alloc(4.5 * 1024 * 1024 + 1);
    // Write PDF header so it passes magic bytes check
    oversized.write('%PDF');
    expect(() => validatePdf(oversized)).toThrow(PdfValidationError);
    expect(() => validatePdf(oversized)).toThrow('exceeds maximum size');
  });
});

describe('extractTaskId', () => {
  it('parses taskId from clickup/{taskId}/file.pdf format', () => {
    expect(extractTaskId('clickup/TASK-123/invoice.pdf')).toBe('TASK-123');
  });

  it('parses taskId with numeric IDs', () => {
    expect(extractTaskId('clickup/86a5w22v4/document.pdf')).toBe('86a5w22v4');
  });

  it('returns null for paths that do not match the pattern', () => {
    expect(extractTaskId('uploads/file.pdf')).toBeNull();
  });

  it('returns null for paths without the clickup prefix', () => {
    expect(extractTaskId('other/TASK-123/file.pdf')).toBeNull();
  });

  it('returns null when clickup is followed by no task segment', () => {
    expect(extractTaskId('clickup/')).toBeNull();
  });
});

describe('sanitizeForPrompt', () => {
  it('removes null bytes', () => {
    expect(sanitizeForPrompt('hello\0world')).toBe('helloworld');
  });

  it('escapes XML closing tags', () => {
    const result = sanitizeForPrompt('</document>');
    expect(result).not.toContain('</');
    expect(result).toContain('[ENDTAG:');
  });

  it('escapes XML opening tags', () => {
    const result = sanitizeForPrompt('<inject>');
    expect(result).not.toContain('<');
    expect(result).toContain('[TAG:');
    expect(result).toContain(':END]');
  });

  it('handles mixed XML tags', () => {
    const result = sanitizeForPrompt('<system>prompt injection</system>');
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
  });

  it('truncates at 50,000 characters', () => {
    const longText = 'a'.repeat(60_000);
    const result = sanitizeForPrompt(longText);
    expect(result.length).toBe(50_000);
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeForPrompt('')).toBe('');
  });

  it('returns empty string for falsy input', () => {
    expect(sanitizeForPrompt(undefined as unknown as string)).toBe('');
  });
});
