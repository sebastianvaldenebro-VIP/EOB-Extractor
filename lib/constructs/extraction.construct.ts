import * as cdk from 'aws-cdk-lib/core';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';
import * as path from 'path';
import { createPipelineFunctions } from './pipeline-functions';
import { createExtractionStateMachine } from './extraction-state-machine';

export interface ExtractionConstructProps {
  readonly eobBucket: s3.IBucket;
  readonly extractionsTable: dynamodb.Table;
  readonly contactsTableName: string;
  readonly phiKey: kms.Key;
  readonly auditKey: kms.Key;
  readonly ingestQueue: sqs.Queue;
  readonly reviewQueue: sqs.Queue;
  readonly dlq: sqs.Queue;
  readonly opsAlertTopic: sns.Topic;
  readonly reviewAlertTopic: sns.Topic;
}

export class ExtractionConstruct extends Construct {
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: ExtractionConstructProps) {
    super(scope, id);

    const handlersPath = path.join(__dirname, '../../src/handlers');

    const sharedLambdaProps: Partial<nodejs.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.SIX_YEARS,
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node20',
        format: nodejs.OutputFormat.ESM,
        mainFields: ['module', 'main'],
      },
    };

    // 1. Pipeline Lambdas (validate-pdf, classify, extract, validate-data, lookup, store)
    const fns = createPipelineFunctions(this, props, sharedLambdaProps, handlersPath);

    // 2. Step Functions state machine
    this.stateMachine = createExtractionStateMachine(this, fns, props.auditKey);

    // 3. Trigger Lambda (created after SFN so it can reference the state machine ARN)
    const triggerFn = new nodejs.NodejsFunction(this, 'TriggerFn', {
      ...sharedLambdaProps,
      functionName: 'eob-trigger',
      entry: path.join(handlersPath, 'trigger.handler.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      reservedConcurrentExecutions: 2,
      environment: {
        STATE_MACHINE_ARN: this.stateMachine.stateMachineArn,
        TABLE_NAME: props.extractionsTable.tableName,
      },
    });
    this.stateMachine.grantStartExecution(triggerFn);
    props.extractionsTable.grantReadData(triggerFn);
    props.phiKey.grantDecrypt(triggerFn);

    // 4. Event wiring: SQS → Trigger, S3 → SQS
    triggerFn.addEventSource(new lambdaEventSources.SqsEventSource(props.ingestQueue, {
      batchSize: 1,
      maxBatchingWindow: cdk.Duration.seconds(0),
      maxConcurrency: 2,
    }));

    props.eobBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(props.ingestQueue),
      { prefix: 'clickup/', suffix: '.pdf' },
    );
  }
}
