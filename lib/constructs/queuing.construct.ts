import * as cdk from 'aws-cdk-lib/core';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export interface QueuingConstructProps {
  readonly encryptionKey: kms.IKey;
}

export class QueuingConstruct extends Construct {
  public readonly ingestQueue: sqs.Queue;
  public readonly reviewQueue: sqs.Queue;
  public readonly dlq: sqs.Queue;
  public readonly reviewDlq: sqs.Queue;

  constructor(scope: Construct, id: string, props: QueuingConstructProps) {
    super(scope, id);

    // Dead letter queue for permanent failures (ingest pipeline)
    this.dlq = new sqs.Queue(this, 'Dlq', {
      queueName: 'eob-extractor-dlq',
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: props.encryptionKey,
      retentionPeriod: cdk.Duration.days(14),
    });

    // Ingest queue: S3 events → Trigger Lambda
    // Visibility timeout = 120s (6x Trigger Lambda timeout of 10s + buffer for SFN start)
    this.ingestQueue = new sqs.Queue(this, 'IngestQueue', {
      queueName: 'eob-extractor-ingest',
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: props.encryptionKey,
      visibilityTimeout: cdk.Duration.seconds(120),
      retentionPeriod: cdk.Duration.hours(4),
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: this.dlq,
      },
    });

    // Dead letter queue for review queue — prevents silent PHI message loss
    this.reviewDlq = new sqs.Queue(this, 'ReviewDlq', {
      queueName: 'eob-extractor-review-dlq',
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: props.encryptionKey,
      retentionPeriod: cdk.Duration.days(14),
    });

    // Review queue: Low-confidence extractions for human review
    this.reviewQueue = new sqs.Queue(this, 'ReviewQueue', {
      queueName: 'eob-extractor-review',
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: props.encryptionKey,
      retentionPeriod: cdk.Duration.days(14),
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: this.reviewDlq,
      },
    });
  }
}
