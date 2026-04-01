import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { logEvent, logError } from '../infrastructure/logging/audit-logger';
import type { EobExtractionResponse } from '../application/schemas/eob-extraction.schema';

const CONTACTS_TABLE = process.env.CONTACTS_TABLE_NAME ?? 'Insurance-Arbitration-contacts';
const CONTACTS_GSI = 'GSI-InsuranceName-LocationState';
const NOTIFY_TOPIC_ARN = process.env.NOTIFY_TOPIC_ARN ?? '';

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const snsClient = new SNSClient({});

interface LookupInput {
  readonly bucket: string;
  readonly key: string;
  readonly taskId: string;
  readonly correlationId: string;
  readonly versionId: string;
  readonly classification: Record<string, unknown>;
  readonly extraction: string;
  readonly extractModelId: string;
  readonly processingDurationMs: number;
  readonly validatedExtraction: EobExtractionResponse;
  readonly confidenceScore: number;
  readonly missingFields: readonly string[];
  readonly warnings: readonly string[];
  readonly isValid: boolean;
}

interface LookupOutput extends LookupInput {
  readonly lookupResult: 'MATCH' | 'MISMATCH' | 'NEW';
  readonly mismatches: readonly string[];
  readonly contactRecord: Record<string, string> | null;
}

/** Fields to compare between extracted data and the contacts table. */
const COMPARE_FIELDS: Array<{ extracted: keyof EobExtractionResponse; contact: string }> = [
  { extracted: 'address', contact: 'Address' },
  { extracted: 'arbitration_email', contact: 'ArbitrationEmail' },
  { extracted: 'arbitration_fax', contact: 'ArbitrationFax' },
  { extracted: 'arbitration_phone', contact: 'ArbitrationPhone' },
  { extracted: 'city', contact: 'City' },
  { extracted: 'state', contact: 'State' },
  { extracted: 'zip_code', contact: 'ZipCode' },
];

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function compareFields(
  extracted: EobExtractionResponse,
  contact: Record<string, unknown>,
): string[] {
  const mismatches: string[] = [];

  for (const { extracted: extractedKey, contact: contactKey } of COMPARE_FIELDS) {
    const extractedVal = normalize(extracted[extractedKey] as string | null);
    const contactVal = normalize(contact[contactKey] as string | null);

    // Skip comparison if both are empty
    if (!extractedVal && !contactVal) continue;
    // Skip if extracted is empty (we don't have data to compare)
    if (!extractedVal) continue;

    if (extractedVal !== contactVal) {
      mismatches.push(`${contactKey}: extracted="${extracted[extractedKey]}" vs existing="${contact[contactKey] ?? ''}"`);
    }
  }

  return mismatches;
}

function buildInsuranceKey(extracted: EobExtractionResponse): string {
  const loc = extracted.location_state ?? '';
  const name = extracted.insurance_name ?? '';
  return `*${loc} - ${name} (PPO)`;
}

export async function handler(event: LookupInput): Promise<LookupOutput> {
  const { correlationId, taskId, key } = event;
  const extracted = event.validatedExtraction;

  logEvent(correlationId, 'lookup_insurance_start', 'INFO', {
    taskId,
    insuranceName: extracted.insurance_name,
    locationState: extracted.location_state,
  });

  try {
    const insuranceName = extracted.insurance_name ?? 'UNKNOWN';
    const locationState = extracted.location_state || 'UNKNOWN';

    // Query contacts table by InsuranceName + LocationState
    const queryResult = await ddbClient.send(new QueryCommand({
      TableName: CONTACTS_TABLE,
      IndexName: CONTACTS_GSI,
      KeyConditionExpression: 'InsuranceName = :name AND LocationState = :state',
      ExpressionAttributeValues: {
        ':name': insuranceName,
        ':state': locationState,
      },
    }));

    const existingContact = queryResult.Items?.[0] as Record<string, unknown> | undefined;

    // --- NO MATCH: Create new record in contacts table ---
    if (!existingContact) {
      const newInsuranceKey = buildInsuranceKey(extracted);

      await ddbClient.send(new PutCommand({
        TableName: CONTACTS_TABLE,
        Item: {
          Insurance: newInsuranceKey,
          InsuranceName: insuranceName,
          LocationState: locationState,
          Address: extracted.address ?? '',
          ArbitrationEmail: extracted.arbitration_email ?? '',
          ArbitrationFax: extracted.arbitration_fax ?? '',
          ArbitrationPhone: extracted.arbitration_phone ?? '',
          City: extracted.city ?? '',
          State: extracted.state ?? '',
          ZipCode: extracted.zip_code ?? '',
        },
        ConditionExpression: 'attribute_not_exists(Insurance)',
      }));

      if (NOTIFY_TOPIC_ARN) {
        await snsClient.send(new PublishCommand({
          TopicArn: NOTIFY_TOPIC_ARN,
          Subject: `New Insurance Contact: ${extracted.insurance_name}`,
          Message: JSON.stringify({
            event: 'new_insurance_contact',
            taskId,
            correlationId,
            insuranceName: extracted.insurance_name,
            locationState: extracted.location_state,
            s3Key: key,
            missingFields: event.missingFields,
            extractedFields: {
              address: extracted.address,
              city: extracted.city,
              state: extracted.state,
              zipCode: extracted.zip_code,
              arbitrationPhone: extracted.arbitration_phone,
              arbitrationFax: extracted.arbitration_fax,
              arbitrationEmail: extracted.arbitration_email,
            },
          }, null, 2),
        }));
      }

      logEvent(correlationId, 'lookup_insurance_new', 'INFO', {
        taskId,
        insuranceName: extracted.insurance_name,
        locationState: extracted.location_state,
      });

      return { ...event, lookupResult: 'NEW', mismatches: [], contactRecord: null };
    }

    // --- MATCH FOUND: Compare fields ---
    const mismatches = compareFields(extracted, existingContact);

    if (mismatches.length > 0) {
      // MISMATCH: fields differ — notify
      if (NOTIFY_TOPIC_ARN) {
        await snsClient.send(new PublishCommand({
          TopicArn: NOTIFY_TOPIC_ARN,
          Subject: `Insurance Contact Mismatch: ${extracted.insurance_name}`,
          Message: JSON.stringify({
            event: 'insurance_contact_mismatch',
            taskId,
            correlationId,
            insuranceName: extracted.insurance_name,
            locationState: extracted.location_state,
            existingInsuranceKey: existingContact.Insurance,
            s3Key: key,
            missingFields: event.missingFields,
            mismatches,
          }, null, 2),
        }));
      }

      logEvent(correlationId, 'lookup_insurance_mismatch', 'WARN', {
        taskId,
        insuranceName: extracted.insurance_name,
        mismatchCount: mismatches.length,
      });

      return {
        ...event,
        lookupResult: 'MISMATCH',
        mismatches,
        contactRecord: existingContact as Record<string, string>,
      };
    }

    // --- MATCH: all fields match — good to go
    logEvent(correlationId, 'lookup_insurance_match', 'INFO', {
      taskId,
      insuranceName: extracted.insurance_name,
      existingInsuranceKey: existingContact.Insurance,
    });

    return {
      ...event,
      lookupResult: 'MATCH',
      mismatches: [],
      contactRecord: existingContact as Record<string, string>,
    };
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logError({
      correlationId,
      errorMessage: err.message,
      errorName: err.name,
      s3Key: key,
      taskId,
    });
    throw error;
  }
}
