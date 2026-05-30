import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EobExtraction } from '../../domain/entities/eob-extraction';
import { EobExtractionRepository } from '../../domain/repositories/eob-extraction.repository';
import { ConfidenceScore } from '../../domain/value-objects/confidence-score';
import { ExtractionStatus } from '../../domain/value-objects/extraction-status';

const TABLE_NAME = process.env.TABLE_NAME ?? 'eob-extractions';

function metaPK(taskId: string): string {
  return `TASK#${taskId}`;
}

function metaSK(extractionId: string): string {
  return `EOB#${extractionId}`;
}

function toItem(extraction: EobExtraction): Record<string, unknown> {
  return {
    PK: metaPK(extraction.taskId),
    SK: metaSK(extraction.extractionId),
    extractionId: extraction.extractionId,
    taskId: extraction.taskId,
    s3Key: extraction.s3Key,
    s3VersionId: extraction.s3VersionId,
    status: extraction.status,
    confidenceScore: extraction.confidenceScore.value,
    insuranceName: extraction.insuranceName,
    insuranceIdentifier: extraction.insuranceIdentifier,
    address: extraction.address,
    city: extraction.city,
    state: extraction.state,
    zipCode: extraction.zipCode,
    locationState: extraction.locationState,
    arbitrationPhone: extraction.arbitrationPhone,
    arbitrationFax: extraction.arbitrationFax,
    arbitrationEmail: extraction.arbitrationEmail,
    rawExtractionJson: extraction.rawExtractionJson,
    modelId: extraction.modelId,
    classificationResult: extraction.classificationResult,
    extractedAt: extraction.extractedAt,
    processingDurationMs: extraction.processingDurationMs,
    correlationId: extraction.correlationId,
  };
}

function itemToExtraction(item: Record<string, unknown>): EobExtraction {
  return EobExtraction.create({
    extractionId: item.extractionId as string,
    taskId: item.taskId as string,
    s3Key: item.s3Key as string,
    s3VersionId: (item.s3VersionId as string) ?? null,
    status: item.status as ExtractionStatus,
    confidenceScore: ConfidenceScore.fromNumber(item.confidenceScore as number),
    insuranceName: (item.insuranceName as string) ?? null,
    insuranceIdentifier: (item.insuranceIdentifier as string) ?? null,
    address: (item.address as string) ?? null,
    city: (item.city as string) ?? null,
    state: (item.state as string) ?? null,
    zipCode: (item.zipCode as string) ?? null,
    locationState: (item.locationState as string) ?? null,
    arbitrationPhone: (item.arbitrationPhone as string) ?? null,
    arbitrationFax: (item.arbitrationFax as string) ?? null,
    arbitrationEmail: (item.arbitrationEmail as string) ?? null,
    rawExtractionJson: item.rawExtractionJson as string,
    modelId: item.modelId as string,
    classificationResult: (item.classificationResult as string) ?? null,
    extractedAt: item.extractedAt as string,
    processingDurationMs: item.processingDurationMs as number,
    correlationId: item.correlationId as string,
  });
}

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: { removeUndefinedValues: true },
});

export class DynamoDbEobRepository implements EobExtractionRepository {
  async save(extraction: EobExtraction): Promise<void> {
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: toItem(extraction),
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
      }),
    );
  }

  async findByTaskId(taskId: string): Promise<readonly EobExtraction[]> {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': metaPK(taskId) },
      }),
    );
    return (result.Items ?? []).map((item) => itemToExtraction(item as Record<string, unknown>));
  }

  async findByExtractionId(taskId: string, extractionId: string): Promise<EobExtraction | null> {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND SK = :sk',
        ExpressionAttributeValues: {
          ':pk': metaPK(taskId),
          ':sk': metaSK(extractionId),
        },
      }),
    );
    const item = result.Items?.[0];
    return item ? itemToExtraction(item as Record<string, unknown>) : null;
  }

  async existsByS3Key(s3Key: string): Promise<boolean> {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI-S3Key',
        KeyConditionExpression: 's3Key = :s3Key',
        ExpressionAttributeValues: { ':s3Key': s3Key },
        Limit: 1,
        Select: 'COUNT',
      }),
    );
    return (result.Count ?? 0) > 0;
  }
}
