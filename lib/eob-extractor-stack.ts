import * as cdk from 'aws-cdk-lib/core';
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
    const contactsTableName = this.node.tryGetContext('contactsTable') ?? 'Insurance-Arbitration-contacts';
    const environment = this.node.tryGetContext('environment') ?? 'sandbox';
    const isProd = environment === 'production';

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
    });

    // Extraction: Step Functions + all Lambdas + wiring
    const extraction = new ExtractionConstruct(this, 'Extraction', {
      eobBucket: storage.eobBucket,
      extractionsTable: storage.extractionsTable,
      contactsTableName,
      phiKey: storage.phiKey,
      auditKey: storage.auditKey,
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
