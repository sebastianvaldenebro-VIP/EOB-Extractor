import { vi } from 'vitest';
import { logExtraction, logError, logEvent } from '../../../src/infrastructure/logging/audit-logger';

describe('audit-logger', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('logExtraction', () => {
    it('outputs structured JSON', () => {
      logExtraction({
        correlationId: 'corr-001',
        extractionId: 'ext-001',
        modelId: 'claude-sonnet',
        status: 'EXTRACTED',
        confidenceScore: 0.95,
        processingDurationMs: 1500,
        s3Key: 'clickup/TASK-1/eob.pdf',
        taskId: 'TASK-1',
      });

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(output.event).toBe('eob_extraction_complete');
      expect(output.level).toBe('INFO');
      expect(output.correlationId).toBe('corr-001');
      expect(output.extractionId).toBe('ext-001');
      expect(output.timestamp).toBeDefined();
    });

    it('does not include PHI fields in output', () => {
      logExtraction({
        correlationId: 'corr-001',
        extractionId: 'ext-001',
        modelId: 'claude-sonnet',
        status: 'EXTRACTED',
        confidenceScore: 0.95,
        processingDurationMs: 1500,
        s3Key: 'clickup/TASK-1/eob.pdf',
        taskId: 'TASK-1',
      });

      const output = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      const outputStr = JSON.stringify(output);

      // Must NOT contain PHI-related keys
      expect(output).not.toHaveProperty('patientName');
      expect(output).not.toHaveProperty('patient_name');
      expect(output).not.toHaveProperty('memberId');
      expect(output).not.toHaveProperty('member_id');
      expect(output).not.toHaveProperty('ssn');
      expect(output).not.toHaveProperty('dateOfBirth');
      expect(output).not.toHaveProperty('address');
      // Should not contain names like "Jane Doe" either
      expect(outputStr).not.toContain('Jane Doe');
    });
  });

  describe('logError', () => {
    it('sanitizes error messages containing PHI patterns', () => {
      logError({
        correlationId: 'corr-002',
        errorMessage: 'Failed for member_id: XYZ123456789',
        errorName: 'ExtractionError',
      });

      const output = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(output.errorMessage).toContain('[REDACTED]');
      expect(output.errorMessage).not.toContain('XYZ123456789');
    });

    it('sanitizes patient_name patterns', () => {
      logError({
        correlationId: 'corr-003',
        errorMessage: 'Error processing patient_name: Jane Doe in record',
        errorName: 'ValidationError',
      });

      const output = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(output.errorMessage).toContain('[REDACTED]');
    });

    it('preserves non-PHI error messages', () => {
      logError({
        correlationId: 'corr-004',
        errorMessage: 'Connection timeout after 30s',
        errorName: 'TimeoutError',
        s3Key: 'clickup/TASK-1/eob.pdf',
      });

      const output = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(output.errorMessage).toBe('Connection timeout after 30s');
      expect(output.level).toBe('ERROR');
      expect(output.s3Key).toBe('clickup/TASK-1/*'); // sanitizeS3Key strips filename
    });
  });

  describe('logEvent', () => {
    it('redacts PHI-like detail keys', () => {
      logEvent('corr-005', 'some_event', 'INFO', {
        patientName: 'Jane Doe',
        operationId: 'op-123',
      });

      const output = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(output.patientName).toBe('[REDACTED]');
      expect(output.operationId).toBe('op-123');
    });
  });
});
