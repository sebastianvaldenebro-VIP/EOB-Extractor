import * as cdk from 'aws-cdk-lib/core';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';
import * as path from 'path';

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

    const stack = cdk.Stack.of(this);
    const handlersPath = path.join(__dirname, '../../src/handlers');

    // Shared Lambda props
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

    // -----------------------------------------------------------------------
    // Lambda: ValidatePDF
    // -----------------------------------------------------------------------
    const validatePdfFn = new nodejs.NodejsFunction(this, 'ValidatePdfFn', {
      ...sharedLambdaProps,
      functionName: 'eob-validate-pdf',
      entry: path.join(handlersPath, 'validate-pdf.handler.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        BUCKET_NAME: props.eobBucket.bucketName,
      },
    });

    // ValidatePDF: s3:GetObject on clickup/*, s3:PutObject on quarantine/*
    props.eobBucket.grantRead(validatePdfFn, 'clickup/*');
    props.eobBucket.grantPut(validatePdfFn, 'quarantine/*');
    props.phiKey.grantDecrypt(validatePdfFn);

    // -----------------------------------------------------------------------
    // Lambda: ClassifyEOB
    // -----------------------------------------------------------------------
    const classifyEobFn = new nodejs.NodejsFunction(this, 'ClassifyEobFn', {
      ...sharedLambdaProps,
      functionName: 'eob-classify-eob',
      entry: path.join(handlersPath, 'classify-eob.handler.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      reservedConcurrentExecutions: 10,
      environment: {
        BUCKET_NAME: props.eobBucket.bucketName,
      },
    });

    // ClassifyEOB: s3:GetObject on clickup/*, bedrock:InvokeModel on Haiku only
    props.eobBucket.grantRead(classifyEobFn, 'clickup/*');
    props.phiKey.grantDecrypt(classifyEobFn);
    classifyEobFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        // Cross-region inference profiles route to any US region
        `arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku*`,
        `arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet*`,
        `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/us.anthropic.claude-haiku*`,
        `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/us.anthropic.claude-sonnet*`,
      ],
    }));

    // -----------------------------------------------------------------------
    // Lambda: ExtractEOB
    // -----------------------------------------------------------------------
    const extractEobFn = new nodejs.NodejsFunction(this, 'ExtractEobFn', {
      ...sharedLambdaProps,
      functionName: 'eob-extract-eob',
      entry: path.join(handlersPath, 'extract-eob.handler.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(300),
      memorySize: 1024,
      reservedConcurrentExecutions: 10,
      environment: {
        BUCKET_NAME: props.eobBucket.bucketName,
      },
    });

    // ExtractEOB: s3:GetObject, bedrock:InvokeModel on Sonnet + Haiku (fallback chain)
    props.eobBucket.grantRead(extractEobFn, 'clickup/*');
    props.phiKey.grantDecrypt(extractEobFn);
    extractEobFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        // Cross-region inference profiles route to any US region
        `arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet*`,
        `arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku*`,
        `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/us.anthropic.claude-sonnet*`,
        `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/us.anthropic.claude-haiku*`,
      ],
    }));

    // -----------------------------------------------------------------------
    // Lambda: ValidateData (pure computation — no AWS service access)
    // -----------------------------------------------------------------------
    const validateDataFn = new nodejs.NodejsFunction(this, 'ValidateDataFn', {
      ...sharedLambdaProps,
      functionName: 'eob-validate-data',
      entry: path.join(handlersPath, 'validate-data.handler.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
    });

    // -----------------------------------------------------------------------
    // Lambda: LookupInsurance
    // -----------------------------------------------------------------------
    const lookupInsuranceFn = new nodejs.NodejsFunction(this, 'LookupInsuranceFn', {
      ...sharedLambdaProps,
      functionName: 'eob-lookup-insurance',
      entry: path.join(handlersPath, 'lookup-insurance.handler.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        CONTACTS_TABLE_NAME: props.contactsTableName,
        NOTIFY_TOPIC_ARN: props.reviewAlertTopic.topicArn,
      },
    });

    // LookupInsurance: DynamoDB read/write on contacts table, SNS publish for notifications
    lookupInsuranceFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:Query', 'dynamodb:PutItem'],
      resources: [
        `arn:aws:dynamodb:${stack.region}:${stack.account}:table/${props.contactsTableName}`,
        `arn:aws:dynamodb:${stack.region}:${stack.account}:table/${props.contactsTableName}/index/*`,
      ],
    }));
    props.reviewAlertTopic.grantPublish(lookupInsuranceFn);

    // -----------------------------------------------------------------------
    // Lambda: StoreResult
    // -----------------------------------------------------------------------
    const storeResultFn = new nodejs.NodejsFunction(this, 'StoreResultFn', {
      ...sharedLambdaProps,
      functionName: 'eob-store-result',
      entry: path.join(handlersPath, 'store-result.handler.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        TABLE_NAME: props.extractionsTable.tableName,
        REVIEW_QUEUE_URL: props.reviewQueue.queueUrl,
      },
    });

    // StoreResult: DynamoDB write, SQS send to review queue, SNS publish
    props.extractionsTable.grantWriteData(storeResultFn);
    props.phiKey.grant(storeResultFn, 'kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey');
    props.reviewQueue.grantSendMessages(storeResultFn);
    props.opsAlertTopic.grantPublish(storeResultFn);
    props.reviewAlertTopic.grantPublish(storeResultFn);

    // -----------------------------------------------------------------------
    // Step Functions State Machine
    // -----------------------------------------------------------------------

    // Task: ValidatePDF
    const validatePdfTask = new tasks.LambdaInvoke(this, 'ValidatePDF', {
      lambdaFunction: validatePdfFn,
      outputPath: '$.Payload',
      retryOnServiceExceptions: true,
    });

    // Task: ClassifyEOB
    const classifyEobTask = new tasks.LambdaInvoke(this, 'ClassifyEOB', {
      lambdaFunction: classifyEobFn,
      outputPath: '$.Payload',
      retryOnServiceExceptions: true,
    });
    classifyEobTask.addRetry({
      errors: ['AllModelsExhaustedException', 'ThrottlingException', 'ServiceUnavailableException'],
      maxAttempts: 3,
      interval: cdk.Duration.seconds(5),
      backoffRate: 2,
    });

    // Task: ExtractEOB
    const extractEobTask = new tasks.LambdaInvoke(this, 'ExtractEOB', {
      lambdaFunction: extractEobFn,
      outputPath: '$.Payload',
      retryOnServiceExceptions: true,
    });
    extractEobTask.addRetry({
      errors: ['AllModelsExhaustedException', 'ThrottlingException', 'ServiceUnavailableException'],
      maxAttempts: 3,
      interval: cdk.Duration.seconds(10),
      backoffRate: 2,
    });

    // Task: ValidateData
    const validateDataTask = new tasks.LambdaInvoke(this, 'ValidateData', {
      lambdaFunction: validateDataFn,
      outputPath: '$.Payload',
      retryOnServiceExceptions: true,
    });

    // Task: StoreResult (high confidence)
    const storeExtractedTask = new tasks.LambdaInvoke(this, 'StoreExtracted', {
      lambdaFunction: storeResultFn,
      outputPath: '$.Payload',
      retryOnServiceExceptions: true,
    });

    // Task: StoreResult (low confidence / review)
    const storeReviewTask = new tasks.LambdaInvoke(this, 'StoreReviewPending', {
      lambdaFunction: storeResultFn,
      outputPath: '$.Payload',
      retryOnServiceExceptions: true,
    });

    // Task: StoreResult (failed — low confidence)
    const storeFailedTask = new tasks.LambdaInvoke(this, 'StoreFailed', {
      lambdaFunction: storeResultFn,
      outputPath: '$.Payload',
      retryOnServiceExceptions: true,
    });

    // Task: LookupInsurance (compare with contacts table)
    const lookupInsuranceTask = new tasks.LambdaInvoke(this, 'LookupInsurance', {
      lambdaFunction: lookupInsuranceFn,
      outputPath: '$.Payload',
      retryOnServiceExceptions: true,
    });

    // Terminal states
    const extractionComplete = new sfn.Succeed(this, 'ExtractionComplete');
    const pdfInvalid = new sfn.Succeed(this, 'PDFInvalid');
    const notAnEob = new sfn.Succeed(this, 'NotAnEOB', {
      comment: 'Document is not an EOB — skipping extraction',
    });
    const matchGoodToGo = new sfn.Succeed(this, 'MatchGoodToGo', {
      comment: 'Insurance contact matched — task is good to go',
    });

    // Choice: Is PDF valid?
    const isPdfValid = new sfn.Choice(this, 'IsPDFValid')
      .when(sfn.Condition.booleanEquals('$.valid', false), pdfInvalid)
      .otherwise(classifyEobTask);

    // Choice: Is document an EOB? (stops pipeline if not)
    const isDocumentEob = new sfn.Choice(this, 'IsDocumentEOB')
      .when(sfn.Condition.booleanEquals('$.isEob', false), notAnEob)
      .otherwise(extractEobTask);

    // Choice: Route by lookup result
    // MATCH → store + good to go (no notification needed)
    // MISMATCH → store + already notified by Lambda
    // NEW → store + already notified + new contact created by Lambda
    const routeByLookup = new sfn.Choice(this, 'RouteByLookup')
      .when(
        sfn.Condition.stringEquals('$.lookupResult', 'MATCH'),
        storeExtractedTask.next(matchGoodToGo),
      )
      .otherwise(
        // MISMATCH or NEW — store and complete (notification already sent by Lambda)
        storeReviewTask.next(extractionComplete),
      );

    // Choice: Route by confidence score
    const routeByConfidence = new sfn.Choice(this, 'RouteByConfidence')
      .when(
        sfn.Condition.numberGreaterThanEquals('$.confidenceScore', 0.50),
        lookupInsuranceTask.next(routeByLookup),
      )
      .otherwise(storeFailedTask.next(extractionComplete));

    // Chain the state machine
    // ValidatePDF → IsPDFValid? → ClassifyEOB → IsEOB? → ExtractEOB → ValidateData
    //   → RouteByConfidence (>=0.50 → LookupInsurance → RouteByLookup, <0.50 → StoreFailed)
    const definition = validatePdfTask
      .next(isPdfValid);

    classifyEobTask
      .next(isDocumentEob);

    extractEobTask
      .next(validateDataTask)
      .next(routeByConfidence);

    // State machine with logging
    const sfnLogGroup = new logs.LogGroup(this, 'SfnLogGroup', {
      logGroupName: '/aws/stepfunctions/eob-extractor',
      retention: logs.RetentionDays.SIX_YEARS,
      encryptionKey: props.auditKey,
    });

    this.stateMachine = new sfn.StateMachine(this, 'EobExtractionSM', {
      stateMachineName: 'eob-extraction-pipeline',
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.minutes(15),
      tracingEnabled: true,
      logs: {
        destination: sfnLogGroup,
        level: sfn.LogLevel.ERROR,
        includeExecutionData: false, // PHI safety: don't log execution data
      },
    });

    // -----------------------------------------------------------------------
    // Lambda: Trigger (SQS → Start SFN)
    // -----------------------------------------------------------------------
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

    // Trigger: SQS consume, SFN start, DynamoDB read (idempotency)
    this.stateMachine.grantStartExecution(triggerFn);
    props.extractionsTable.grantReadData(triggerFn);
    props.phiKey.grantDecrypt(triggerFn);

    // Wire SQS → Trigger Lambda
    triggerFn.addEventSource(new lambdaEventSources.SqsEventSource(props.ingestQueue, {
      batchSize: 1,
      maxBatchingWindow: cdk.Duration.seconds(0),
      maxConcurrency: 2,
    }));

    // Wire S3 event → SQS (clickup/ prefix, .pdf suffix)
    props.eobBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(props.ingestQueue),
      { prefix: 'clickup/', suffix: '.pdf' },
    );
  }
}
