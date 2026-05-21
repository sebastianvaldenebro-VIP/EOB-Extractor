import { vi, describe, it, expect, beforeEach } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  createHandler,
  type LookupInsuranceDeps,
} from '../../../src/handlers/lookup-insurance.handler';
import type { EobExtractionResponse } from '../../../src/application/schemas/eob-extraction.schema';

vi.mock('../../../src/infrastructure/logging/audit-logger', () => ({
  logEvent: vi.fn(),
  logError: vi.fn(),
}));

// Set the topic ARN env var so notification paths are exercised
process.env.NOTIFY_TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:test-topic';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildExtraction(overrides: Partial<EobExtractionResponse> = {}): EobExtractionResponse {
  return {
    is_eob: true,
    confidence_score: 0.95,
    extraction_notes: null,
    insurance_name: 'Blue Cross Blue Shield of Illinois',
    insurance_identifier: 'BCBS-IL-60054',
    address: '123 Main St',
    city: 'Chicago',
    state: 'IL',
    zip_code: '60601',
    location_state: 'IL',
    arbitration_phone: '1-800-555-0100',
    arbitration_fax: '1-800-555-0101',
    arbitration_email: 'arbitration@bcbsil.com',
    ...overrides,
  };
}

function buildInput(extractionOverrides: Partial<EobExtractionResponse> = {}) {
  const validatedExtraction = buildExtraction(extractionOverrides);
  return {
    bucket: 'bucket-specialops-sandbox',
    key: 'clickup/TASK-200/eob.pdf',
    taskId: 'TASK-200',
    correlationId: 'corr-test-002',
    versionId: 'v1',
    classification: { documentType: 'eob' },
    extraction: JSON.stringify(validatedExtraction),
    extractModelId: 'claude-sonnet',
    processingDurationMs: 2000,
    validatedExtraction,
    confidenceScore: validatedExtraction.confidence_score,
    missingFields: [] as readonly string[],
    warnings: [] as readonly string[],
    isValid: true,
  } as const;
}

function buildMatchingContact() {
  return {
    Insurance: '*IL - Blue Cross Blue Shield of Illinois',
    InsuranceName: 'Blue Cross Blue Shield of Illinois',
    LocationState: 'IL',
    Address: '123 Main St',
    ArbitrationEmail: 'arbitration@bcbsil.com',
    ArbitrationFax: '1-800-555-0101',
    ArbitrationPhone: '1-800-555-0100',
    City: 'Chicago',
    State: 'IL',
    ZipCode: '60601',
  };
}

/** Build mock deps. queryResult=undefined means no contact found (NEW path). */
function buildDeps(overrides: {
  queryResult?: Record<string, unknown>;
  createContactError?: Error;
} = {}): {
  deps: LookupInsuranceDeps;
  publishCalls: Array<{ topicArn: string; subject: string; message: string }>;
  createContactCalls: Array<Record<string, unknown>>;
} {
  const publishCalls: Array<{ topicArn: string; subject: string; message: string }> = [];
  const createContactCalls: Array<Record<string, unknown>> = [];

  const deps: LookupInsuranceDeps = {
    queryContact: vi.fn().mockResolvedValue(overrides.queryResult),
    createContact: vi.fn().mockImplementation(async (item: Record<string, unknown>) => {
      createContactCalls.push(item);
      if (overrides.createContactError) throw overrides.createContactError;
    }),
    publishNotification: vi.fn().mockImplementation(
      async (topicArn: string, subject: string, message: string) => {
        publishCalls.push({ topicArn, subject, message });
      },
    ),
  };

  return { deps, publishCalls, createContactCalls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('lookup-insurance handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('MATCH path', () => {
    it('returns lookupResult=MATCH when existing contact fields match extraction', async () => {
      const { deps } = buildDeps({ queryResult: buildMatchingContact() });
      const result = await createHandler(deps)(buildInput());

      expect(result.lookupResult).toBe('MATCH');
      expect(result.mismatches).toEqual([]);
      expect(result.contactRecord).toEqual(buildMatchingContact());
    });

    it('does not publish to SNS when fields match', async () => {
      const { deps, publishCalls } = buildDeps({ queryResult: buildMatchingContact() });
      await createHandler(deps)(buildInput());

      expect(publishCalls).toHaveLength(0);
    });

    it('preserves all input fields in the output', async () => {
      const { deps } = buildDeps({ queryResult: buildMatchingContact() });
      const input = buildInput();
      const result = await createHandler(deps)(input);

      expect(result.bucket).toBe(input.bucket);
      expect(result.key).toBe(input.key);
      expect(result.taskId).toBe(input.taskId);
      expect(result.correlationId).toBe(input.correlationId);
      expect(result.isValid).toBe(input.isValid);
      expect(result.confidenceScore).toBe(input.confidenceScore);
    });

    it('treats case-insensitive field equality as MATCH after normalization', async () => {
      const { deps } = buildDeps({
        queryResult: { ...buildMatchingContact(), Address: '123 MAIN ST' },
      });
      const result = await createHandler(deps)(buildInput());

      expect(result.lookupResult).toBe('MATCH');
      expect(result.mismatches).toEqual([]);
    });
  });

  describe('MISMATCH path', () => {
    it('returns lookupResult=MISMATCH when existing contact has different fields', async () => {
      const { deps } = buildDeps({
        queryResult: { ...buildMatchingContact(), Address: '999 Other Blvd', City: 'Springfield' },
      });
      const result = await createHandler(deps)(buildInput());

      expect(result.lookupResult).toBe('MISMATCH');
      expect(result.mismatches.length).toBeGreaterThan(0);
      expect(result.mismatches.some((m: string) => m.includes('Address'))).toBe(true);
      expect(result.mismatches.some((m: string) => m.includes('City'))).toBe(true);
    });

    it('publishes SNS notification on mismatch', async () => {
      const { deps, publishCalls } = buildDeps({
        queryResult: { ...buildMatchingContact(), ArbitrationPhone: '1-800-999-9999' },
      });
      await createHandler(deps)(buildInput());

      expect(publishCalls).toHaveLength(1);
      expect(publishCalls[0].topicArn).toBe('arn:aws:sns:us-east-1:123456789012:test-topic');
      expect(publishCalls[0].subject).toContain('Mismatch');

      const messageBody = JSON.parse(publishCalls[0].message);
      expect(messageBody.event).toBe('insurance_contact_mismatch');
      expect(messageBody.mismatches.length).toBeGreaterThan(0);
    });
  });

  describe('NEW path', () => {
    it('creates new record and returns lookupResult=NEW when no existing contact found', async () => {
      const { deps } = buildDeps();
      const result = await createHandler(deps)(buildInput());

      expect(result.lookupResult).toBe('NEW');
      expect(result.mismatches).toEqual([]);
      expect(result.contactRecord).toBeNull();
    });

    it('calls createContact with correct item structure', async () => {
      const { deps, createContactCalls } = buildDeps();
      await createHandler(deps)(buildInput());

      expect(createContactCalls).toHaveLength(1);
      expect(createContactCalls[0]).toEqual(expect.objectContaining({
        Insurance: '*IL - Blue Cross Blue Shield of Illinois',
        InsuranceName: 'Blue Cross Blue Shield of Illinois',
        LocationState: 'IL',
        Address: '123 Main St',
        City: 'Chicago',
        State: 'IL',
        ZipCode: '60601',
        ArbitrationPhone: '1-800-555-0100',
        ArbitrationFax: '1-800-555-0101',
        ArbitrationEmail: 'arbitration@bcbsil.com',
      }));
    });

    it('publishes SNS notification for new contact', async () => {
      const { deps, publishCalls } = buildDeps();
      await createHandler(deps)(buildInput());

      expect(publishCalls).toHaveLength(1);
      expect(publishCalls[0].subject).toContain('New Insurance Contact');

      const messageBody = JSON.parse(publishCalls[0].message);
      expect(messageBody.event).toBe('new_insurance_contact');
      expect(messageBody.insuranceName).toBe('Blue Cross Blue Shield of Illinois');
      expect(messageBody.locationState).toBe('IL');
    });

    it('returns NEW when queryContact returns undefined', async () => {
      const { deps } = buildDeps({ queryResult: undefined });
      const result = await createHandler(deps)(buildInput());

      expect(result.lookupResult).toBe('NEW');
      expect(result.contactRecord).toBeNull();
    });
  });

  describe('UNKNOWN fallback for null/empty insurance_name or location_state', () => {
    it('passes UNKNOWN as insuranceName to queryContact when insurance_name is null', async () => {
      const { deps } = buildDeps();
      await createHandler(deps)(buildInput({ insurance_name: null }));

      expect(deps.queryContact).toHaveBeenCalledWith('UNKNOWN', expect.any(String));
    });

    it('passes UNKNOWN as locationState to queryContact when location_state is empty', async () => {
      const { deps } = buildDeps();
      await createHandler(deps)(buildInput({ location_state: '' }));

      expect(deps.queryContact).toHaveBeenCalledWith(expect.any(String), 'UNKNOWN');
    });

    it('passes UNKNOWN as locationState to queryContact when location_state is null', async () => {
      const { deps } = buildDeps();
      await createHandler(deps)(buildInput({ location_state: null }));

      expect(deps.queryContact).toHaveBeenCalledWith(expect.any(String), 'UNKNOWN');
    });

    it('writes UNKNOWN as InsuranceName when creating new contact with null insurance_name', async () => {
      const { deps, createContactCalls } = buildDeps();
      await createHandler(deps)(buildInput({ insurance_name: null }));

      expect((createContactCalls[0]).InsuranceName).toBe('UNKNOWN');
    });

    it('writes UNKNOWN as LocationState when creating new contact with empty location_state', async () => {
      const { deps, createContactCalls } = buildDeps();
      await createHandler(deps)(buildInput({ location_state: '' }));

      expect((createContactCalls[0]).LocationState).toBe('UNKNOWN');
    });
  });

  describe('error handling', () => {
    it('throws when queryContact fails', async () => {
      const { deps } = buildDeps();
      (deps.queryContact as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DynamoDB throttle'));

      await expect(createHandler(deps)(buildInput())).rejects.toThrow('DynamoDB throttle');
    });

    it('throws when createContact fails with non-conditional error', async () => {
      const { deps } = buildDeps({
        createContactError: new Error('ProvisionedThroughputExceededException'),
      });

      await expect(createHandler(deps)(buildInput())).rejects.toThrow('ProvisionedThroughputExceededException');
    });

    it('swallows ConditionalCheckFailedException on concurrent write and returns NEW', async () => {
      const { deps, publishCalls } = buildDeps({
        createContactError: new ConditionalCheckFailedException({ message: 'concurrent', $metadata: {} }),
      });

      const result = await createHandler(deps)(buildInput());

      expect(result.lookupResult).toBe('NEW');
      expect(result.contactRecord).toBeNull();
      expect(result.mismatches).toEqual([]);
      expect(publishCalls).toHaveLength(0);
    });
  });
});
