import * as cdk from 'aws-cdk-lib/core';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import { StorageConstruct } from './constructs/storage.construct';
import { QueuingConstruct } from './constructs/queuing.construct';
import { MonitoringConstruct } from './constructs/monitoring.construct';
import { ExtractionConstruct } from './constructs/extraction.construct';
import { DashboardConstruct } from './constructs/dashboard.construct';

export class EobExtractorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Get config from CDK context (varies per environment)
    const bucketName = this.node.tryGetContext('bucketName') ?? 'bucket-specialops-sandbox';
    const contactsTableName = this.node.tryGetContext('contactsTable') ?? 'Insurance-Arbitration-Contacts';
    const environment = this.node.tryGetContext('environment') ?? 'sandbox';
    const isProd = environment === 'production';

    // The source PDFs are written by SendClickUpAttachmentsToS3 (Arbitration
    // stack), which passes its own SSE-KMS key and so overrides the bucket
    // default. That key lives in another domain, so this stack has to be
    // granted kms:Decrypt on it explicitly — the key policy already allows it,
    // what was missing is the identity grant. Without it the whole pipeline
    // fails at the first step that reads the object:
    //
    //   eob-validate-pdf is not authorized to perform: kms:Decrypt on
    //   key/4ae0f1f9... because no identity-based policy allows the action
    //
    // (2026-08-10: 12 of 12 executions failing.) Optional on purpose — in
    // sandbox the uploader writes with the bucket default key.
    // OJO: el bloque `environments` de cdk.json NO lo resuelve CDK solo —
    // tryGetContext('x') busca una clave de PRIMER nivel. Por eso el comando de
    // deploy pasa bucketName/environment/contactsTable con -c. Poner el ARN solo
    // dentro de environments.production lo dejaba invisible: el 2026-08-10 el
    // deploy salio "exitoso" sin aplicar ni un statement de KMS.
    // Se lee del bloque por entorno, y un -c explicito lo sobreescribe.
    const envConfig = (this.node.tryGetContext('environments') ?? {})[environment] ?? {};
    const sourceKmsKeyArn = (this.node.tryGetContext('sourceKmsKeyArn')
      ?? envConfig.sourceKmsKeyArn) as string | undefined;
    const sourceObjectKey = sourceKmsKeyArn
      ? kms.Key.fromKeyArn(this, 'SourceObjectKey', sourceKmsKeyArn)
      : undefined;

    // Storage: Import existing S3 bucket, create DynamoDB table, KMS keys
    const storage = new StorageConstruct(this, 'Storage', {
      bucketName,
      isProd,
    });

    // Queuing: SQS ingest, review, and DLQ
    const queuing = new QueuingConstruct(this, 'Queuing', {
      encryptionKey: storage.phiKey,
    });

    // Monitoring: SNS topics, CloudWatch alarms
    const monitoring = new MonitoringConstruct(this, 'Monitoring', {
      encryptionKey: storage.auditKey,
      dlq: queuing.dlq,
      reviewQueue: queuing.reviewQueue,
      reviewDlq: queuing.reviewDlq,
    });

    // Extraction: Step Functions + all Lambdas + wiring
    const extraction = new ExtractionConstruct(this, 'Extraction', {
      eobBucket: storage.eobBucket,
      extractionsTable: storage.extractionsTable,
      contactsTableName,
      phiKey: storage.phiKey,
      auditKey: storage.auditKey,
      sourceObjectKey,
      ingestQueue: queuing.ingestQueue,
      reviewQueue: queuing.reviewQueue,
      dlq: queuing.dlq,
      opsAlertTopic: monitoring.opsAlertTopic,
      reviewAlertTopic: monitoring.reviewAlertTopic,
    });

    // Dashboard: CloudWatch operational visibility
    new DashboardConstruct(this, 'Dashboard', {
      stateMachine: extraction.stateMachine,
      ingestQueue: queuing.ingestQueue,
      reviewQueue: queuing.reviewQueue,
      dlq: queuing.dlq,
    });

    // Tags for HIPAA compliance
    cdk.Tags.of(this).add('Project', 'eob-extractor');
    cdk.Tags.of(this).add('Environment', environment);
    cdk.Tags.of(this).add('Owner', 'engineering');
    cdk.Tags.of(this).add('Compliance', 'hipaa');
    cdk.Tags.of(this).add('ManagedBy', 'cdk');
    cdk.Tags.of(this).add('CostCenter', this.node.tryGetContext('costCenter') ?? 'engineering');

    // Outputs
    new cdk.CfnOutput(this, 'ExtractionsTableName', {
      value: storage.extractionsTable.tableName,
    });
    new cdk.CfnOutput(this, 'IngestQueueUrl', {
      value: queuing.ingestQueue.queueUrl,
    });
    new cdk.CfnOutput(this, 'OpsAlertTopicArn', {
      value: monitoring.opsAlertTopic.topicArn,
    });
    new cdk.CfnOutput(this, 'ReviewAlertTopicArn', {
      value: monitoring.reviewAlertTopic.topicArn,
    });
  }
}
