import * as cdk from 'aws-cdk-lib/core';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import type { PipelineFunctions } from './pipeline-functions';

/**
 * Builds the Step Functions state machine definition and log group under the given scope.
 * scope MUST be the ExtractionConstruct itself to preserve CDK logical IDs.
 */
export function createExtractionStateMachine(
  scope: Construct,
  fns: PipelineFunctions,
  auditKey: kms.Key,
): sfn.StateMachine {
  const validatePdfTask = new tasks.LambdaInvoke(scope, 'ValidatePDF', {
    lambdaFunction: fns.validatePdfFn,
    outputPath: '$.Payload',
    retryOnServiceExceptions: true,
  });

  const classifyEobTask = new tasks.LambdaInvoke(scope, 'ClassifyEOB', {
    lambdaFunction: fns.classifyEobFn,
    outputPath: '$.Payload',
    retryOnServiceExceptions: true,
  });
  classifyEobTask.addRetry({
    errors: ['AllModelsExhaustedException', 'ThrottlingException', 'ServiceUnavailableException'],
    maxAttempts: 3,
    interval: cdk.Duration.seconds(5),
    backoffRate: 2,
  });

  const extractEobTask = new tasks.LambdaInvoke(scope, 'ExtractEOB', {
    lambdaFunction: fns.extractEobFn,
    outputPath: '$.Payload',
    retryOnServiceExceptions: true,
  });
  extractEobTask.addRetry({
    errors: ['AllModelsExhaustedException', 'ThrottlingException', 'ServiceUnavailableException'],
    maxAttempts: 3,
    interval: cdk.Duration.seconds(10),
    backoffRate: 2,
  });

  const validateDataTask = new tasks.LambdaInvoke(scope, 'ValidateData', {
    lambdaFunction: fns.validateDataFn,
    outputPath: '$.Payload',
    retryOnServiceExceptions: true,
  });

  const storeExtractedTask = new tasks.LambdaInvoke(scope, 'StoreExtracted', {
    lambdaFunction: fns.storeResultFn,
    outputPath: '$.Payload',
    retryOnServiceExceptions: true,
  });

  const storeReviewTask = new tasks.LambdaInvoke(scope, 'StoreReviewPending', {
    lambdaFunction: fns.storeResultFn,
    outputPath: '$.Payload',
    retryOnServiceExceptions: true,
  });

  const storeFailedTask = new tasks.LambdaInvoke(scope, 'StoreFailed', {
    lambdaFunction: fns.storeResultFn,
    outputPath: '$.Payload',
    retryOnServiceExceptions: true,
  });

  const lookupInsuranceTask = new tasks.LambdaInvoke(scope, 'LookupInsurance', {
    lambdaFunction: fns.lookupInsuranceFn,
    outputPath: '$.Payload',
    retryOnServiceExceptions: true,
  });

  const extractionComplete = new sfn.Succeed(scope, 'ExtractionComplete');
  const pdfInvalid = new sfn.Succeed(scope, 'PDFInvalid');
  const notAnEob = new sfn.Succeed(scope, 'NotAnEOB', {
    comment: 'Document is not an EOB — skipping extraction',
  });
  const matchGoodToGo = new sfn.Succeed(scope, 'MatchGoodToGo', {
    comment: 'Insurance contact matched — task is good to go',
  });

  const isPdfValid = new sfn.Choice(scope, 'IsPDFValid')
    .when(sfn.Condition.booleanEquals('$.valid', false), pdfInvalid)
    .otherwise(classifyEobTask);

  const isDocumentEob = new sfn.Choice(scope, 'IsDocumentEOB')
    .when(sfn.Condition.booleanEquals('$.isEob', false), notAnEob)
    .otherwise(extractEobTask);

  const routeByLookup = new sfn.Choice(scope, 'RouteByLookup')
    .when(
      sfn.Condition.stringEquals('$.lookupResult', 'MATCH'),
      storeExtractedTask.next(matchGoodToGo),
    )
    .otherwise(storeReviewTask.next(extractionComplete));

  const routeByConfidence = new sfn.Choice(scope, 'RouteByConfidence')
    .when(
      sfn.Condition.numberGreaterThanEquals('$.confidenceScore', 0.50),
      lookupInsuranceTask.next(routeByLookup),
    )
    .otherwise(storeFailedTask.next(extractionComplete));

  const definition = validatePdfTask.next(isPdfValid);
  classifyEobTask.next(isDocumentEob);
  extractEobTask.next(validateDataTask).next(routeByConfidence);

  const sfnLogGroup = new logs.LogGroup(scope, 'SfnLogGroup', {
    logGroupName: '/aws/stepfunctions/eob-extractor',
    retention: logs.RetentionDays.SIX_YEARS,
    encryptionKey: auditKey,
  });

  return new sfn.StateMachine(scope, 'EobExtractionSM', {
    stateMachineName: 'eob-extraction-pipeline',
    definitionBody: sfn.DefinitionBody.fromChainable(definition),
    timeout: cdk.Duration.minutes(15),
    tracingEnabled: true,
    logs: {
      destination: sfnLogGroup,
      level: sfn.LogLevel.ALL,
      includeExecutionData: false,
    },
  });
}
