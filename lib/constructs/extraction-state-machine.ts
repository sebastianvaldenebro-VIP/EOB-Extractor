import * as cdk from 'aws-cdk-lib/core';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import type { PipelineFunctions } from './pipeline-functions';

/**
 * Reintento para cuando Lambda rechaza la invocacion por concurrencia agotada.
 *
 * `retryOnServiceExceptions: true` NO cubre este error: el retrier que genera CDK
 * lleva ClientExecutionTimeout, ServiceException, AWSLambdaException y
 * SdkClientException, pero no TooManyRequestsException. Sin este retrier el 429
 * no se reintenta y la ejecucion muere al primer rechazo — el 2026-08-11 un lote
 * de ~56 ejecuciones simultaneas contra classify-eob y extract-eob, que tienen
 * concurrencia reservada de 10, tumbo 14 ejecuciones asi.
 *
 * El presupuesto es deliberadamente largo (5+10+20+...+1280 ≈ 42 min) porque lo
 * que hay que esperar es que DRENE la cola, no un error transitorio: con 10
 * ranuras y extract-eob en timeout de 300s, un lote de 56 puede tardar media
 * hora. No cuesta nada cuando no hay lote, porque solo entra si hay throttle.
 *
 * La alternativa —subir la concurrencia reservada— moveria el fallo a la cuota de
 * Bedrock, que es un limite mas duro y menos controlable. El 10 es un guardian
 * deliberado de esa cuota.
 */
const CONCURRENCIA_AGOTADA = {
  errors: ['Lambda.TooManyRequestsException'],
  maxAttempts: 9,
  interval: cdk.Duration.seconds(5),
  backoffRate: 2,
};

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
  classifyEobTask.addRetry(CONCURRENCIA_AGOTADA);
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
  extractEobTask.addRetry(CONCURRENCIA_AGOTADA);
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

  // Separate state for schema validation failures — keeps isValid flag live and meaningful
  const storeInvalidTask = new tasks.LambdaInvoke(scope, 'StoreInvalid', {
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
  // Terminal failure state for unhandled Lambda errors.
  // Without this, SFN executions fail with opaque "States.Runtime" errors and
  // no structured error info is captured in the execution history.
  const pipelineFailed = new sfn.Fail(scope, 'PipelineFailed', {
    comment: 'Unhandled error — see SFN execution history for error/cause detail',
  });

  // Route all unhandled Lambda errors to PipelineFailed.
  // addRetry (on classifyEob/extractEob) takes precedence for matching errors;
  // addCatch only fires after retries are exhausted or for non-retried errors.
  const allTasks = [
    validatePdfTask, classifyEobTask, extractEobTask, validateDataTask,
    lookupInsuranceTask, storeExtractedTask, storeReviewTask, storeFailedTask, storeInvalidTask,
  ];
  for (const task of allTasks) {
    task.addCatch(pipelineFailed, { errors: ['States.ALL'] });
  }

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

  // isValid gate: schema failures short-circuit to StoreFailed before confidence routing.
  // When isValid:false, confidenceScore is already 0.1 (set by validate-data handler),
  // but checking isValid explicitly makes the intent clear and guards against future drift.
  const checkIsValid = new sfn.Choice(scope, 'CheckIsValid')
    .when(sfn.Condition.booleanEquals('$.isValid', false), storeInvalidTask.next(extractionComplete))
    .otherwise(routeByConfidence);

  const definition = validatePdfTask.next(isPdfValid);
  classifyEobTask.next(isDocumentEob);
  extractEobTask.next(validateDataTask).next(checkIsValid);

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
