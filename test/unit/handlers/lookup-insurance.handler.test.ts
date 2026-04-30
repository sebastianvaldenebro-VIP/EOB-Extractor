import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { EobExtractionResponse } from '../../../src/application/schemas/eob-extraction.schema';

// ---------------------------------------------------------------------------
// AWS SDK mocks — must be set up before handler import
// ---------------------------------------------------------------------------

const mockDdbSend = vi.fn();
const mockSnsSend = vi.fn();

/** Tracks all QueryCommand constructor calls for assertion. */
const queryCommandCalls: Array<Record<string, unknown>> = [];
/** Tracks all PutCommand constructor calls for assertion. */
const putCommandCalls: Array<Record<string, unknown>> = [];
/** Tracks all PublishCommand constructor calls for assertion. */
const publishCommandCalls: Array<Record<string, unknown>> = [];

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class MockDynamoDBClient {},
}));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: () => ({ send: mockDdbSend }),
  },
  QueryCommand: class MockQueryCommand {
    constructor(input: Record<string, unknown>) {
      queryCommandCalls.push(input);
      Object.assign(this, input);
    }
  },
  PutCommand: class MockPutCommand {
    constructor(input: Record<string, unknown>) {
      putCommandCalls.push(input);
      Object.assign(this, input);
    }
  },
}));

vi.mock('@aws-sdk/client-sns', () => ({
  SNSClient: class MockSNSClient {
    send = mockSnsSend;
  },
  PublishCommand: class MockPublishCommand {
    constructor(input: Record<string, unknown>) {
      publishCommandCalls.push(input);
      Object.assign(this, input);
    }
  },
}));

vi.mock('../../../src/infrastructure/logging/audit-logger', () => ({
  logEvent: vi.fn(),
  logError: vi.fn(),
}));

// Set env vars BEFORE handler import — module-level constants capture these at load time
process.env.CONTACTS_TABLE_NAME = 'TestContactsTable';
process.env.NOTIFY_TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:test-topic';

// Import handler after mocks and env vars are established
const { handler } = await import('../../../src/handlers/lookup-insurance.handler');

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

/** Simulates a DynamoDB contact record that matches the extracted data exactly. */
function buildMatchingContact() {
  return {
    Insurance: '*IL - Blue Cross Blue Shield of Illinois (PPO)',
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('lookup-insurance handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDdbSend.mockReset();
    mockSnsSend.mockReset();
    queryCommandCalls.length = 0;
    putCommandCalls.length = 0;
    publishCommandCalls.length = 0;
  });

  describe('MATCH path', () => {
    it('returns lookupResult=MATCH when existing contact fields match extraction', async () => {
      mockDdbSend.mockResolvedValueOnce({
        Items: [buildMatchingContact()],
      });

      const result = await handler(buildInput());

      expect(result.lookupResult).toBe('MATCH');
      expect(result.mismatches).toEqual([]);
      expect(result.contactRecord).toEqual(buildMatchingContact());
    });

    it('does not publish to SNS when fields match', async () => {
      mockDdbSend.mockResolvedValueOnce({
        Items: [buildMatchingContact()],
      });

      await handler(buildInput());

      expect(mockSnsSend).not.toHaveBeenCalled();
      expect(publishCommandCalls).toHaveLength(0);
    });

    it('preserves all input fields in the output', async () => {
      mockDdbSend.mockResolvedValueOnce({
        Items: [buildMatchingContact()],
      });

      const input = buildInput();
      const result = await handler(input);

      expect(result.bucket).toBe(input.bucket);
      expect(result.key).toBe(input.key);
      expect(result.taskId).toBe(input.taskId);
      expect(result.correlationId).toBe(input.correlationId);
      expect(result.isValid).toBe(input.isValid);
      expect(result.confidenceScore).toBe(input.confidenceScore);
    });
  });

  describe('MISMATCH path', () => {
    it('returns lookupResult=MISMATCH when existing contact has different fields', async () => {
      const mismatchedContact = {
        ...buildMatchingContact(),
        Address: '999 Other Blvd',
        City: 'Springfield',
      };

      mockDdbSend.mockResolvedValueOnce({
        Items: [mismatchedContact],
      });

      const result = await handler(buildInput());

      expect(result.lookupResult).toBe('MISMATCH');
      expect(result.mismatches.length).toBeGreaterThan(0);
      expect(result.mismatches.some((m: string) => m.includes('Address'))).toBe(true);
      expect(result.mismatches.some((m: string) => m.includes('City'))).toBe(true);
      expect(result.contactRecord).toEqual(mismatchedContact);
    });

    it('publishes SNS notification on mismatch', async () => {
      const mismatchedContact = {
        ...buildMatchingContact(),
        ArbitrationPhone: '1-800-999-9999',
      };

      mockDdbSend.mockResolvedValueOnce({
        Items: [mismatchedContact],
      });

      await handler(buildInput());

      expect(mockSnsSend).toHaveBeenCalledTimes(1);
      expect(publishCommandCalls).toHaveLength(1);

      const publishInput = publishCommandCalls[0];
      expect(publishInput.TopicArn).toBe('arn:aws:sns:us-east-1:123456789012:test-topic');
      expect(publishInput.Subject).toContain('Mismatch');

      const messageBody = JSON.parse(publishInput.Message as string);
      expect(messageBody.event).toBe('insurance_contact_mismatch');
      expect(messageBody.mismatches.length).toBeGreaterThan(0);
    });

    it('treats case-insensitive field equality as MATCH after normalization', async () => {
      // normalize() lowercases and trims, so "123 MAIN ST" vs "123 Main St" should MATCH
      const contactSameButDifferentCase = {
        ...buildMatchingContact(),
        Address: '123 MAIN ST',
      };

      mockDdbSend.mockResolvedValueOnce({
        Items: [contactSameButDifferentCase],
      });

      const result = await handler(buildInput());

      expect(result.lookupResult).toBe('MATCH');
      expect(result.mismatches).toEqual([]);
    });
  });

  describe('NEW path', () => {
    it('creates new record and returns lookupResult=NEW when no existing contact found', async () => {
      mockDdbSend.mockResolvedValueOnce({ Items: [] });
      mockDdbSend.mockResolvedValueOnce({});

      const result = await handler(buildInput());

      expect(result.lookupResult).toBe('NEW');
      expect(result.mismatches).toEqual([]);
      expect(result.contactRecord).toBeNull();
    });

    it('calls PutCommand with correct item structure', async () => {
      mockDdbSend.mockResolvedValueOnce({ Items: [] });
      mockDdbSend.mockResolvedValueOnce({});

      await handler(buildInput());

      expect(mockDdbSend).toHaveBeenCalledTimes(2);
      expect(putCommandCalls).toHaveLength(1);

      const putInput = putCommandCalls[0];
      expect(putInput.ConditionExpression).toBe('attribute_not_exists(Insurance)');
      expect(putInput.Item).toEqual(expect.objectContaining({
        Insurance: '*IL - Blue Cross Blue Shield of Illinois (PPO)',
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
      mockDdbSend.mockResolvedValueOnce({ Items: [] });
      mockDdbSend.mockResolvedValueOnce({});

      await handler(buildInput());

      expect(mockSnsSend).toHaveBeenCalledTimes(1);
      expect(publishCommandCalls).toHaveLength(1);

      const publishInput = publishCommandCalls[0];
      expect(publishInput.Subject).toContain('New Insurance Contact');

      const messageBody = JSON.parse(publishInput.Message as string);
      expect(messageBody.event).toBe('new_insurance_contact');
      expect(messageBody.insuranceName).toBe('Blue Cross Blue Shield of Illinois');
      expect(messageBody.locationState).toBe('IL');
    });

    it('returns NEW when query result Items is undefined', async () => {
      mockDdbSend.mockResolvedValueOnce({ Items: undefined });
      mockDdbSend.mockResolvedValueOnce({});

      const result = await handler(buildInput());

      expect(result.lookupResult).toBe('NEW');
      expect(result.contactRecord).toBeNull();
    });
  });

  describe('empty insurance_name/location_state uses UNKNOWN', () => {
    it('uses UNKNOWN for null insurance_name in query key', async () => {
      mockDdbSend.mockResolvedValueOnce({ Items: [] });
      mockDdbSend.mockResolvedValueOnce({});

      await handler(buildInput({ insurance_name: null }));

      expect(queryCommandCalls).toHaveLength(1);
      expect(queryCommandCalls[0].ExpressionAttributeValues).toEqual(
        expect.objectContaining({ ':name': 'UNKNOWN' }),
      );
    });

    it('uses UNKNOWN for empty string location_state in query key', async () => {
      mockDdbSend.mockResolvedValueOnce({ Items: [] });
      mockDdbSend.mockResolvedValueOnce({});

      await handler(buildInput({ location_state: '' }));

      expect(queryCommandCalls).toHaveLength(1);
      expect(queryCommandCalls[0].ExpressionAttributeValues).toEqual(
        expect.objectContaining({ ':state': 'UNKNOWN' }),
      );
    });

    it('uses UNKNOWN for null location_state to avoid DynamoDB empty string key error', async () => {
      mockDdbSend.mockResolvedValueOnce({ Items: [] });
      mockDdbSend.mockResolvedValueOnce({});

      await handler(buildInput({ location_state: null }));

      expect(queryCommandCalls).toHaveLength(1);
      expect(queryCommandCalls[0].ExpressionAttributeValues).toEqual(
        expect.objectContaining({ ':state': 'UNKNOWN' }),
      );
    });

    it('writes UNKNOWN as InsuranceName when creating new contact with null insurance_name', async () => {
      mockDdbSend.mockResolvedValueOnce({ Items: [] });
      mockDdbSend.mockResolvedValueOnce({});

      await handler(buildInput({ insurance_name: null }));

      expect(putCommandCalls).toHaveLength(1);
      expect((putCommandCalls[0].Item as Record<string, unknown>).InsuranceName).toBe('UNKNOWN');
    });

    it('writes UNKNOWN as LocationState when creating new contact with empty location_state', async () => {
      mockDdbSend.mockResolvedValueOnce({ Items: [] });
      mockDdbSend.mockResolvedValueOnce({});

      await handler(buildInput({ location_state: '' }));

      expect(putCommandCalls).toHaveLength(1);
      expect((putCommandCalls[0].Item as Record<string, unknown>).LocationState).toBe('UNKNOWN');
    });
  });

  describe('error handling', () => {
    it('throws when DynamoDB query fails', async () => {
      mockDdbSend.mockRejectedValueOnce(new Error('DynamoDB throttle'));

      await expect(handler(buildInput())).rejects.toThrow('DynamoDB throttle');
    });

    it('throws when DynamoDB put fails', async () => {
      mockDdbSend.mockResolvedValueOnce({ Items: [] });
      mockDdbSend.mockRejectedValueOnce(new Error('ConditionalCheckFailedException'));

      await expect(handler(buildInput())).rejects.toThrow('ConditionalCheckFailedException');
    });
  });
});
