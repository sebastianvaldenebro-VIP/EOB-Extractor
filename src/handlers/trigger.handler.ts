import type { SQSEvent } from 'aws-lambda';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoDbEobRepository } from '../infrastructure/persistence/dynamodb-eob.repository';
import { extractTaskId } from '../infrastructure/storage/s3-pdf-reader';
import { logEvent, logError } from '../infrastructure/logging/audit-logger';
import { ulid } from 'ulid';

const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN ?? '';
const sfnClient = new SFNClient({});
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const repository = new DynamoDbEobRepository();

interface S3EventRecord {
  readonly s3: {
    readonly bucket: { readonly name: string };
    readonly object: { readonly key: string };
  };
}

interface S3EventNotification {
  readonly Records: readonly S3EventRecord[];
}

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    const correlationId = ulid();

    try {
      const s3Event: S3EventNotification = JSON.parse(record.body);
      const s3Record = s3Event.Records[0];
      const bucket = s3Record.s3.bucket.name;
      const key = decodeURIComponent(s3Record.s3.object.key.replace(/\+/g, ' '));

      const taskId = extractTaskId(key);
      if (!taskId) {
        logEvent(correlationId, 'trigger_skip_invalid_key', 'WARN', { s3Key: key });
        continue;
      }

      logEvent(correlationId, 'trigger_received', 'INFO', { s3Key: key, taskId });

      const alreadyProcessed = await repository.existsByS3Key(key);
      if (alreadyProcessed) {
        logEvent(correlationId, 'trigger_skip_duplicate', 'INFO', { s3Key: key, taskId });
        continue;
      }

      await sfnClient.send(
        new StartExecutionCommand({
          stateMachineArn: STATE_MACHINE_ARN,
          name: `eob-${taskId}-${correlationId}`,
          input: JSON.stringify({ bucket, key, taskId, correlationId }),
        }),
      );

      logEvent(correlationId, 'trigger_sfn_started', 'INFO', { taskId, s3Key: key });
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logError({
        correlationId,
        errorMessage: err.message,
        errorName: err.name,
      });
      throw error;
    }
  }
}
