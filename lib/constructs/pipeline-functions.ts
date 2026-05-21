import * as cdk from 'aws-cdk-lib/core';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';
import type { ExtractionConstructProps } from './extraction.construct';

export interface PipelineFunctions {
  readonly validatePdfFn: nodejs.NodejsFunction;
  readonly classifyEobFn: nodejs.NodejsFunction;
  readonly extractEobFn: nodejs.NodejsFunction;
  readonly validateDataFn: nodejs.NodejsFunction;
  readonly lookupInsuranceFn: nodejs.NodejsFunction;
  readonly storeResultFn: nodejs.NodejsFunction;
}

/**
 * Creates the 6 pipeline Lambda functions under the given scope.
 * scope MUST be the ExtractionConstruct itself to preserve CDK logical IDs.
 */
export function createPipelineFunctions(
  scope: Construct,
  props: ExtractionConstructProps,
  sharedProps: Partial<nodejs.NodejsFunctionProps>,
  handlersPath: string,
): PipelineFunctions {
  const stack = cdk.Stack.of(scope);

  const validatePdfFn = new nodejs.NodejsFunction(scope, 'ValidatePdfFn', {
    ...sharedProps,
    functionName: 'eob-validate-pdf',
    entry: path.join(handlersPath, 'validate-pdf.handler.ts'),
    handler: 'handler',
    timeout: cdk.Duration.seconds(30),
    memorySize: 512,
    environment: { BUCKET_NAME: props.eobBucket.bucketName },
  });
  props.eobBucket.grantRead(validatePdfFn, 'clickup/*');
  props.eobBucket.grantPut(validatePdfFn, 'quarantine/*');
  props.phiKey.grantDecrypt(validatePdfFn);

  const classifyEobFn = new nodejs.NodejsFunction(scope, 'ClassifyEobFn', {
    ...sharedProps,
    functionName: 'eob-classify-eob',
    entry: path.join(handlersPath, 'classify-eob.handler.ts'),
    handler: 'handler',
    timeout: cdk.Duration.seconds(60),
    memorySize: 512,
    reservedConcurrentExecutions: 10,
    environment: { BUCKET_NAME: props.eobBucket.bucketName },
  });
  props.eobBucket.grantRead(classifyEobFn, 'clickup/*');
  props.phiKey.grantDecrypt(classifyEobFn);
  classifyEobFn.addToRolePolicy(new iam.PolicyStatement({
    actions: ['bedrock:InvokeModel'],
    resources: [
      `arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-haiku*`,
      `arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-haiku*`,
      `arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-haiku*`,
      `arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet*`,
      `arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-sonnet*`,
      `arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet*`,
      `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/us.anthropic.claude-haiku*`,
      `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/us.anthropic.claude-sonnet*`,
    ],
  }));

  const extractEobFn = new nodejs.NodejsFunction(scope, 'ExtractEobFn', {
    ...sharedProps,
    functionName: 'eob-extract-eob',
    entry: path.join(handlersPath, 'extract-eob.handler.ts'),
    handler: 'handler',
    timeout: cdk.Duration.seconds(300),
    memorySize: 1024,
    reservedConcurrentExecutions: 10,
    environment: { BUCKET_NAME: props.eobBucket.bucketName },
  });
  props.eobBucket.grantRead(extractEobFn, 'clickup/*');
  props.phiKey.grantDecrypt(extractEobFn);
  extractEobFn.addToRolePolicy(new iam.PolicyStatement({
    actions: ['bedrock:InvokeModel'],
    resources: [
      `arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet*`,
      `arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-sonnet*`,
      `arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet*`,
      `arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-haiku*`,
      `arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-haiku*`,
      `arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-haiku*`,
      `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/us.anthropic.claude-sonnet*`,
      `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/us.anthropic.claude-haiku*`,
    ],
  }));

  const validateDataFn = new nodejs.NodejsFunction(scope, 'ValidateDataFn', {
    ...sharedProps,
    functionName: 'eob-validate-data',
    entry: path.join(handlersPath, 'validate-data.handler.ts'),
    handler: 'handler',
    timeout: cdk.Duration.seconds(30),
    memorySize: 256,
  });

  const lookupInsuranceFn = new nodejs.NodejsFunction(scope, 'LookupInsuranceFn', {
    ...sharedProps,
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
  lookupInsuranceFn.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:Query', 'dynamodb:PutItem'],
    resources: [
      `arn:aws:dynamodb:${stack.region}:${stack.account}:table/${props.contactsTableName}`,
      `arn:aws:dynamodb:${stack.region}:${stack.account}:table/${props.contactsTableName}/index/*`,
    ],
  }));
  props.reviewAlertTopic.grantPublish(lookupInsuranceFn);

  const storeResultFn = new nodejs.NodejsFunction(scope, 'StoreResultFn', {
    ...sharedProps,
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
  props.extractionsTable.grantWriteData(storeResultFn);
  props.phiKey.grant(storeResultFn, 'kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey');
  props.reviewQueue.grantSendMessages(storeResultFn);
  props.opsAlertTopic.grantPublish(storeResultFn);
  props.reviewAlertTopic.grantPublish(storeResultFn);

  return {
    validatePdfFn,
    classifyEobFn,
    extractEobFn,
    validateDataFn,
    lookupInsuranceFn,
    storeResultFn,
  };
}
