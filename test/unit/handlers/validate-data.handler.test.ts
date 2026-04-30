import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { EobExtractionResponse } from '../../../src/application/schemas/eob-extraction.schema';
import highConfidence from '../../fixtures/sample-eob-responses/valid-high-confidence.json';
import lowConfidence from '../../fixtures/sample-eob-responses/valid-low-confidence.json';
import notEob from '../../fixtures/sample-eob-responses/not-eob.json';

// Mock audit-logger to prevent console noise and avoid side-effects
vi.mock('../../../src/infrastructure/logging/audit-logger', () => ({
  logEvent: vi.fn(),
  logError: vi.fn(),
}));

// Import handler AFTER mocks are established
const { handler } = await import('../../../src/handlers/validate-data.handler');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildInput(extractionOverrides: Partial<EobExtractionResponse> = {}) {
  const extraction = { ...highConfidence, ...extractionOverrides };
  return {
    bucket: 'bucket-specialops-sandbox',
    key: 'clickup/TASK-100/eob.pdf',
    taskId: 'TASK-100',
    correlationId: 'corr-test-001',
    versionId: 'v1',
    classification: { documentType: 'eob' },
    extraction: JSON.stringify(extraction),
    extractModelId: 'claude-sonnet',
    processingDurationMs: 2000,
  } as const;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validate-data handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('valid extraction data', () => {
    it('returns isValid=true with correct output shape for valid high-confidence EOB', async () => {
      const input = buildInput();
      const result = await handler(input);

      // Verify the output extends the input (passthrough)
      expect(result.bucket).toBe(input.bucket);
      expect(result.key).toBe(input.key);
      expect(result.taskId).toBe(input.taskId);
      expect(result.correlationId).toBe(input.correlationId);
      expect(result.versionId).toBe(input.versionId);
      expect(result.extraction).toBe(input.extraction);

      // Verify validation output shape
      expect(result.isValid).toBe(true);
      expect(result.validatedExtraction).toBeDefined();
      expect(result.validatedExtraction.is_eob).toBe(true);
      expect(result.validatedExtraction.insurance_name).toBe('Blue Cross Blue Shield of Illinois');
      expect(result.missingFields).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it('includes all expected output keys', async () => {
      const result = await handler(buildInput());

      const expectedKeys = [
        'bucket', 'key', 'taskId', 'correlationId', 'versionId',
        'classification', 'extraction', 'extractModelId', 'processingDurationMs',
        'validatedExtraction', 'confidenceScore', 'missingFields', 'warnings', 'isValid',
      ];

      for (const key of expectedKeys) {
        expect(result).toHaveProperty(key);
      }
    });
  });

  describe('confidence score passthrough', () => {
    it('passes through confidence_score from validated extraction', async () => {
      const result = await handler(buildInput());
      expect(result.confidenceScore).toBe(0.95);
    });

    it('passes through low confidence score unchanged', async () => {
      const input = {
        ...buildInput(),
        extraction: JSON.stringify(lowConfidence),
      };
      const result = await handler(input);
      expect(result.confidenceScore).toBe(0.62);
    });
  });

  describe('missing fields reported as warnings but still valid', () => {
    it('reports missing fields for incomplete EOB but stays valid', async () => {
      const input = buildInput({
        address: null,
        city: null,
        arbitration_fax: null,
      });
      const result = await handler(input);

      expect(result.isValid).toBe(true);
      expect(result.missingFields).toContain('address');
      expect(result.missingFields).toContain('city');
      expect(result.missingFields).toContain('arbitration_fax');
    });

    it('reports empty strings as missing fields', async () => {
      const input = buildInput({
        insurance_name: '',
        zip_code: '',
      });
      const result = await handler(input);

      expect(result.isValid).toBe(true);
      expect(result.missingFields).toContain('insurance_name');
      expect(result.missingFields).toContain('zip_code');
    });

    it('reports all null fields as missing for sparse extraction', async () => {
      const input = {
        ...buildInput(),
        extraction: JSON.stringify(lowConfidence),
      };
      const result = await handler(input);

      expect(result.isValid).toBe(true);
      // low-confidence fixture has many null fields
      expect(result.missingFields).toContain('insurance_identifier');
      expect(result.missingFields).toContain('address');
      expect(result.missingFields).toContain('city');
      expect(result.missingFields).toContain('zip_code');
      expect(result.missingFields).toContain('location_state');
      expect(result.missingFields).toContain('arbitration_phone');
      expect(result.missingFields).toContain('arbitration_fax');
      expect(result.missingFields).toContain('arbitration_email');
    });
  });

  describe('is_eob: false', () => {
    it('returns isValid=true with no missing fields when document is not an EOB', async () => {
      const input = {
        ...buildInput(),
        extraction: JSON.stringify(notEob),
      };
      const result = await handler(input);

      // Non-EOB documents still pass validation — business rules skip missing field checks
      expect(result.isValid).toBe(true);
      expect(result.missingFields).toHaveLength(0);
      expect(result.validatedExtraction.is_eob).toBe(false);
    });

    it('passes through the confidence score even for non-EOB', async () => {
      const input = {
        ...buildInput(),
        extraction: JSON.stringify(notEob),
      };
      const result = await handler(input);
      expect(result.confidenceScore).toBe(0.98);
    });
  });

  describe('schema validation failure', () => {
    it('returns isValid=false with low confidence when extraction is not valid JSON schema', async () => {
      const malformed = { unexpected_field: 'bad data' };
      const input = {
        ...buildInput(),
        extraction: JSON.stringify(malformed),
      };
      const result = await handler(input);

      expect(result.isValid).toBe(false);
      expect(result.confidenceScore).toBe(0.1);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('throws on unparseable JSON extraction string', async () => {
      const input = {
        ...buildInput(),
        extraction: 'not-json-at-all',
      };

      await expect(handler(input)).rejects.toThrow();
    });
  });

  describe('format warnings', () => {
    it('includes warning for unusual state format', async () => {
      const input = buildInput({ state: 'Illinois' });
      const result = await handler(input);

      expect(result.isValid).toBe(true);
      expect(result.warnings.some((w: string) => w.includes('state'))).toBe(true);
    });

    it('includes warning for unusual zip_code format', async () => {
      const input = buildInput({ zip_code: 'ABC' });
      const result = await handler(input);

      expect(result.isValid).toBe(true);
      expect(result.warnings.some((w: string) => w.includes('zip_code'))).toBe(true);
    });
  });
});
