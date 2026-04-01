import { EobExtraction } from '../../../src/domain/entities/eob-extraction';
import { ConfidenceScore } from '../../../src/domain/value-objects/confidence-score';
import { ExtractionStatus } from '../../../src/domain/value-objects/extraction-status';

function buildMinimalProps(overrides: Record<string, unknown> = {}) {
  return {
    extractionId: '01ABCDEF',
    taskId: 'TASK-123',
    s3Key: 'clickup/TASK-123/eob.pdf',
    s3VersionId: 'v1',
    status: ExtractionStatus.EXTRACTED,
    confidenceScore: ConfidenceScore.fromNumber(0.95),
    insuranceName: null,
    insuranceIdentifier: null,
    address: null,
    city: null,
    state: null,
    zipCode: null,
    locationState: null,
    arbitrationPhone: null,
    arbitrationFax: null,
    arbitrationEmail: null,
    rawExtractionJson: '{}',
    modelId: 'us.anthropic.claude-sonnet-4-6',
    classificationResult: null,
    extractedAt: '2024-11-15T00:00:00.000Z',
    processingDurationMs: 1500,
    correlationId: 'corr-123',
    ...overrides,
  };
}

describe('EobExtraction', () => {
  describe('create', () => {
    it('reconstitutes entity from props with provided extractionId', () => {
      const props = buildMinimalProps();
      const entity = EobExtraction.create(props);

      expect(entity.extractionId).toBe('01ABCDEF');
      expect(entity.taskId).toBe('TASK-123');
      expect(entity.status).toBe(ExtractionStatus.EXTRACTED);
      expect(entity.confidenceScore.value).toBe(0.95);
    });

    it('preserves all nullable fields when set', () => {
      const props = buildMinimalProps({
        insuranceName: 'BCBS',
        address: '123 Main St',
        city: 'Chicago',
        state: 'IL',
        zipCode: '60601',
        locationState: 'IL',
        arbitrationPhone: '1-800-555-0100',
        arbitrationFax: '1-800-555-0101',
        arbitrationEmail: 'arb@bcbs.com',
      });
      const entity = EobExtraction.create(props);

      expect(entity.insuranceName).toBe('BCBS');
      expect(entity.address).toBe('123 Main St');
      expect(entity.city).toBe('Chicago');
      expect(entity.state).toBe('IL');
      expect(entity.zipCode).toBe('60601');
      expect(entity.arbitrationEmail).toBe('arb@bcbs.com');
    });

    it('preserves null for all nullable fields when not set', () => {
      const entity = EobExtraction.create(buildMinimalProps());

      expect(entity.insuranceName).toBeNull();
      expect(entity.insuranceIdentifier).toBeNull();
      expect(entity.address).toBeNull();
      expect(entity.city).toBeNull();
      expect(entity.state).toBeNull();
      expect(entity.zipCode).toBeNull();
      expect(entity.locationState).toBeNull();
      expect(entity.arbitrationPhone).toBeNull();
      expect(entity.arbitrationFax).toBeNull();
      expect(entity.arbitrationEmail).toBeNull();
    });
  });

  describe('createFromExtraction', () => {
    const nullFields = {
      insuranceName: null,
      insuranceIdentifier: null,
      address: null,
      city: null,
      state: null,
      zipCode: null,
      locationState: null,
      arbitrationPhone: null,
      arbitrationFax: null,
      arbitrationEmail: null,
    } as const;

    it('generates a ULID extraction ID', () => {
      const entity = EobExtraction.createFromExtraction(
        'TASK-456',
        'clickup/TASK-456/eob.pdf',
        'v2',
        ConfidenceScore.fromNumber(0.90),
        '{"data": true}',
        'us.anthropic.claude-sonnet-4-6',
        'EOB',
        2000,
        'corr-456',
        { ...nullFields },
      );

      // ULID is 26 chars
      expect(entity.extractionId).toHaveLength(26);
      expect(entity.taskId).toBe('TASK-456');
    });

    it('derives status from confidence score (HIGH -> EXTRACTED)', () => {
      const entity = EobExtraction.createFromExtraction(
        'TASK-456',
        'clickup/TASK-456/eob.pdf',
        null,
        ConfidenceScore.fromNumber(0.90),
        '{}',
        'model-id',
        null,
        1000,
        'corr-789',
        { ...nullFields },
      );

      expect(entity.status).toBe(ExtractionStatus.EXTRACTED);
    });

    it('derives status from confidence score (MEDIUM -> REVIEW_PENDING)', () => {
      const entity = EobExtraction.createFromExtraction(
        'TASK-456',
        'clickup/TASK-456/eob.pdf',
        null,
        ConfidenceScore.fromNumber(0.60),
        '{}',
        'model-id',
        null,
        1000,
        'corr-789',
        { ...nullFields },
      );

      expect(entity.status).toBe(ExtractionStatus.REVIEW_PENDING);
    });

    it('sets extractedAt timestamp', () => {
      const before = new Date().toISOString();
      const entity = EobExtraction.createFromExtraction(
        'TASK-456',
        'clickup/TASK-456/eob.pdf',
        null,
        ConfidenceScore.fromNumber(0.90),
        '{}',
        'model-id',
        null,
        1000,
        'corr-789',
        { ...nullFields },
      );
      const after = new Date().toISOString();

      expect(entity.extractedAt >= before).toBe(true);
      expect(entity.extractedAt <= after).toBe(true);
    });

    it('populates extraction fields when provided', () => {
      const entity = EobExtraction.createFromExtraction(
        'TASK-456',
        'clickup/TASK-456/eob.pdf',
        null,
        ConfidenceScore.fromNumber(0.90),
        '{}',
        'model-id',
        'EOB',
        1000,
        'corr-789',
        {
          insuranceName: 'Aetna',
          insuranceIdentifier: 'AET-001',
          address: '456 Oak Ave',
          city: 'New York',
          state: 'NY',
          zipCode: '10001',
          locationState: 'NY',
          arbitrationPhone: '1-800-555-0200',
          arbitrationFax: '1-800-555-0201',
          arbitrationEmail: 'arb@aetna.com',
        },
      );

      expect(entity.insuranceName).toBe('Aetna');
      expect(entity.insuranceIdentifier).toBe('AET-001');
      expect(entity.address).toBe('456 Oak Ave');
      expect(entity.city).toBe('New York');
      expect(entity.state).toBe('NY');
      expect(entity.zipCode).toBe('10001');
      expect(entity.locationState).toBe('NY');
      expect(entity.arbitrationPhone).toBe('1-800-555-0200');
      expect(entity.arbitrationFax).toBe('1-800-555-0201');
      expect(entity.arbitrationEmail).toBe('arb@aetna.com');
    });
  });
});
