import type { SQSEvent } from 'aws-lambda';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { DynamoDbEobRepository } from '../infrastructure/persistence/dynamodb-eob.repository';
import { extractTaskId } from '../infrastructure/storage/s3-pdf-reader';
import { logEvent, logError } from '../infrastructure/logging/audit-logger';
import { ulid } from 'ulid';

const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN ?? '';

export interface TriggerDeps {
  readonly existsByS3Key: (s3Key: string) => Promise<boolean>;
  readonly startExecution: (name: string, input: string) => Promise<void>;
}

interface S3EventRecord {
  readonly s3: {
    readonly bucket: { readonly name: string };
    readonly object: { readonly key: string };
  };
}

interface S3EventNotification {
  readonly Records: readonly S3EventRecord[];
}

export function createHandler(deps: TriggerDeps) {
  return async function handler(event: SQSEvent): Promise<void> {
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

        const alreadyProcessed = await deps.existsByS3Key(key);
        if (alreadyProcessed) {
          logEvent(correlationId, 'trigger_skip_duplicate', 'INFO', { s3Key: key, taskId });
          continue;
        }

        const executionName = `eob-${taskId}-${correlationId}`;
        await deps.startExecution(executionName, JSON.stringify({ bucket, key, taskId, correlationId }));

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
  };
}

const repository = new DynamoDbEobRepository();
const sfnClient = new SFNClient({});

export const handler = createHandler({
  existsByS3Key: (key) => repository.existsByS3Key(key),
  startExecution: async (name, input) => {
    await sfnClient.send(new StartExecutionCommand({
      stateMachineArn: STATE_MACHINE_ARN,
      name,
      input,
    }));
  },
});
