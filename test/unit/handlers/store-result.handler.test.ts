import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { EobExtractionResponse } from '../../../src/application/schemas/eob-extraction.schema';
import { ExtractionStatus } from '../../../src/domain/value-objects/extraction-status';
import highConfidence from '../../fixtures/sample-eob-responses/valid-high-confidence.json';

// Mock audit-logger to prevent console noise and avoid side-effects
vi.mock('../../../src/infrastructure/logging/audit-logger', () => ({
  logEvent: vi.fn(),
  logError: vi.fn(),
  logExtraction: vi.fn(),
}));

// REVIEW_QUEUE_URL is read at module load — set it BEFORE importing the handler
// so the REVIEW_PENDING branch is reachable in this module instance.
process.env.REVIEW_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/000000000000/review-queue';

// Import handler AFTER mocks and env are established
const { createHandler } = await import('../../../src/handlers/store-result.handler');
const { logError } = await import('../../../src/infrastructure/logging/audit-logger');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDeps() {
  return {
    repository: { save: vi.fn().mockResolvedValue(undefined) },
    sendToReviewQueue: vi.fn().mockResolvedValue(undefined),
  };
}

function buildInput(confidenceScore: number, extractionOverrides: Partial<EobExtractionResponse> = {}) {
  const validatedExtraction = { ...highConfidence, ...extractionOverrides } as EobExtractionResponse;
  return {
    bucket: 'bucket-specialops-sandbox',
    key: 'clickup/TASK-100/eob.pdf',
    taskId: 'TASK-100',
    correlationId: 'corr-test-001',
    versionId: 'v1',
    classification: { documentType: 'eob' },
    extraction: JSON.stringify(validatedExtraction),
    extractModelId: 'claude-sonnet',
    processingDurationMs: 2000,
    validatedExtraction,
    confidenceScore,
    missingFields: [] as const,
    warnings: [] as const,
    isValid: true,
    lookupResult: 'match',
    mismatches: [] as const,
    contactRecord: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('store-result handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('high confidence (>= 0.85) — EXTRACTED', () => {
    it('persists the extraction and returns EXTRACTED without queueing review', async () => {
      const deps = buildDeps();
      const handler = createHandler(deps);

      const result = await handler(buildInput(0.95));

      expect(deps.repository.save).toHaveBeenCalledTimes(1);
      expect(deps.sendToReviewQueue).not.toHaveBeenCalled();
      expect(result.status).toBe(ExtractionStatus.EXTRACTED);
      expect(result.taskId).toBe('TASK-100');
      expect(result.confidenceScore).toBe(0.95);
      expect(result.extractionId).toEqual(expect.any(String));
    });

    it('treats the 0.85 boundary as EXTRACTED', async () => {
      const deps = buildDeps();
      const handler = createHandler(deps);

      const result = await handler(buildInput(0.85));

      expect(result.status).toBe(ExtractionStatus.EXTRACTED);
      expect(deps.sendToReviewQueue).not.toHaveBeenCalled();
    });
  });

  describe('medium confidence (0.50–0.85) — REVIEW_PENDING', () => {
    it('persists and sends the extraction to the review queue', async () => {
      const deps = buildDeps();
      const handler = createHandler(deps);

      const result = await handler(buildInput(0.62));

      expect(result.status).toBe(ExtractionStatus.REVIEW_PENDING);
      expect(deps.repository.save).toHaveBeenCalledTimes(1);
      expect(deps.sendToReviewQueue).toHaveBeenCalledTimes(1);

      const message = JSON.parse(deps.sendToReviewQueue.mock.calls[0][0]);
      expect(message).toMatchObject({
        taskId: 'TASK-100',
        correlationId: 'corr-test-001',
        confidenceScore: 0.62,
        status: ExtractionStatus.REVIEW_PENDING,
      });
      expect(message.extractionId).toBe(result.extractionId);
    });

    it('treats the 0.50 boundary as REVIEW_PENDING', async () => {
      const deps = buildDeps();
      const handler = createHandler(deps);

      const result = await handler(buildInput(0.5));

      expect(result.status).toBe(ExtractionStatus.REVIEW_PENDING);
      expect(deps.sendToReviewQueue).toHaveBeenCalledTimes(1);
    });

    it('skips the review queue when REVIEW_QUEUE_URL is unset at module load', async () => {
      vi.resetModules();
      const previous = process.env.REVIEW_QUEUE_URL;
      delete process.env.REVIEW_QUEUE_URL;
      try {
        const fresh = await import('../../../src/handlers/store-result.handler');
        const deps = buildDeps();
        const handler = fresh.createHandler(deps);

        const result = await handler(buildInput(0.62));

        expect(result.status).toBe(ExtractionStatus.REVIEW_PENDING);
        expect(deps.repository.save).toHaveBeenCalledTimes(1);
        expect(deps.sendToReviewQueue).not.toHaveBeenCalled();
      } finally {
        process.env.REVIEW_QUEUE_URL = previous;
      }
    });
  });

  describe('low confidence (< 0.50) — FAILED', () => {
    it('persists as FAILED and does not queue review', async () => {
      const deps = buildDeps();
      const handler = createHandler(deps);

      const result = await handler(buildInput(0.1));

      expect(result.status).toBe(ExtractionStatus.FAILED);
      expect(deps.repository.save).toHaveBeenCalledTimes(1);
      expect(deps.sendToReviewQueue).not.toHaveBeenCalled();
    });
  });

  describe('error paths', () => {
    it('rethrows and logs when the repository save fails', async () => {
      const deps = buildDeps();
      deps.repository.save.mockRejectedValue(new Error('DynamoDB unavailable'));
      const handler = createHandler(deps);

      await expect(handler(buildInput(0.95))).rejects.toThrow('DynamoDB unavailable');
      expect(logError).toHaveBeenCalledTimes(1);
      expect(logError).toHaveBeenCalledWith(expect.objectContaining({
        correlationId: 'corr-test-001',
        errorMessage: 'DynamoDB unavailable',
      }));
    });

    it('rethrows when the review queue send fails on REVIEW_PENDING', async () => {
      const deps = buildDeps();
      deps.sendToReviewQueue.mockRejectedValue(new Error('SQS throttled'));
      const handler = createHandler(deps);

      await expect(handler(buildInput(0.62))).rejects.toThrow('SQS throttled');
      expect(deps.repository.save).toHaveBeenCalledTimes(1);
      expect(logError).toHaveBeenCalledTimes(1);
    });

    it('rejects out-of-range confidence scores without persisting', async () => {
      const deps = buildDeps();
      const handler = createHandler(deps);

      await expect(handler(buildInput(1.5))).rejects.toThrow(/between 0 and 1/);
      expect(deps.repository.save).not.toHaveBeenCalled();
      expect(logError).toHaveBeenCalledTimes(1);
    });
  });
});
