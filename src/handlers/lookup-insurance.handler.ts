import { DynamoDBClient, ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { logEvent, logError } from '../infrastructure/logging/audit-logger';
import type { EobExtractionResponse } from '../application/schemas/eob-extraction.schema';

const CONTACTS_TABLE = process.env.CONTACTS_TABLE_NAME ?? '';
const CONTACTS_GSI = 'GSI-InsuranceName-LocationState';

export interface LookupInsuranceDeps {
  readonly queryContact: (insuranceName: string, locationState: string) => Promise<Record<string, unknown> | undefined>;
  readonly createContact: (item: Record<string, unknown>) => Promise<void>;
  readonly publishNotification: (topicArn: string, subject: string, message: string) => Promise<void>;
}

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

    if (!extractedVal && !contactVal) continue;
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
  return `*${loc} - ${name}`;
}

export function createHandler(deps: LookupInsuranceDeps) {
  return async function handler(event: LookupInput): Promise<LookupOutput> {
    const { correlationId, taskId, key } = event;
    const extracted = event.validatedExtraction;

    // insurance_name is the insurer's organizational name (e.g. "Blue Cross Blue Shield"),
    // not an individual identifier — logging it is intentional and does not constitute PHI.
    logEvent(correlationId, 'lookup_insurance_start', 'INFO', {
      taskId,
      insuranceName: extracted.insurance_name,
      locationState: extracted.location_state,
    });

    try {
      const notifyTopicArn = process.env.NOTIFY_TOPIC_ARN ?? '';
      const insuranceName = extracted.insurance_name ?? 'UNKNOWN';
      const locationState = extracted.location_state || 'UNKNOWN';

      const existingContact = await deps.queryContact(insuranceName, locationState);

      if (!existingContact) {
        const newInsuranceKey = buildInsuranceKey(extracted);

        try {
          await deps.createContact({
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
          });

          if (notifyTopicArn) {
            await deps.publishNotification(
              notifyTopicArn,
              `New Insurance Contact: ${extracted.insurance_name}`,
              JSON.stringify({
                event: 'new_insurance_contact',
                taskId,
                correlationId,
                insuranceName: extracted.insurance_name,
                locationState: extracted.location_state,
                s3Key: key,
                missingFields: event.missingFields,
                // These are the insurer's arbitration department contact fields,
                // not patient data — safe to include in operational SNS notifications.
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
            );
          }

          logEvent(correlationId, 'lookup_insurance_new', 'INFO', {
            taskId,
            insuranceName: extracted.insurance_name,
            locationState: extracted.location_state,
          });
        } catch (putError: unknown) {
          if (!(putError instanceof ConditionalCheckFailedException)) throw putError;
          // Concurrent execution already wrote this contact — treat as no-op
          logEvent(correlationId, 'lookup_insurance_new_concurrent_skip', 'INFO', { taskId });
        }

        return { ...event, lookupResult: 'NEW', mismatches: [], contactRecord: null };
      }

      const mismatches = compareFields(extracted, existingContact);

      if (mismatches.length > 0) {
        if (notifyTopicArn) {
          await deps.publishNotification(
            notifyTopicArn,
            `Insurance Contact Mismatch: ${extracted.insurance_name}`,
            JSON.stringify({
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
          );
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
  };
}

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const snsClient = new SNSClient({});

export const handler = createHandler({
  queryContact: async (insuranceName, locationState) => {
    if (!CONTACTS_TABLE) throw new Error('CONTACTS_TABLE_NAME env var is required');
    const result = await ddbClient.send(new QueryCommand({
      TableName: CONTACTS_TABLE,
      IndexName: CONTACTS_GSI,
      KeyConditionExpression: 'InsuranceName = :name AND LocationState = :state',
      ExpressionAttributeValues: { ':name': insuranceName, ':state': locationState },
    }));
    return result.Items?.[0] as Record<string, unknown> | undefined;
  },
  createContact: async (item) => {
    if (!CONTACTS_TABLE) throw new Error('CONTACTS_TABLE_NAME env var is required');
    await ddbClient.send(new PutCommand({
      TableName: CONTACTS_TABLE,
      Item: item,
      ConditionExpression: 'attribute_not_exists(Insurance)',
    }));
  },
  publishNotification: async (topicArn, subject, message) => {
    await snsClient.send(new PublishCommand({ TopicArn: topicArn, Subject: subject, Message: message }));
  },
});
