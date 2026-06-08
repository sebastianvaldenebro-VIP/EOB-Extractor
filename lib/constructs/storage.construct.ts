import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface StorageConstructProps {
  readonly bucketName: string;
  readonly isProd: boolean;
}

export class StorageConstruct extends Construct {
  public readonly eobBucket: s3.IBucket;
  public readonly auditBucket: s3.Bucket;
  public readonly phiKey: kms.Key;
  public readonly auditKey: kms.Key;
  public readonly extractionsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: StorageConstructProps) {
    super(scope, id);

    const account = cdk.Stack.of(this).account;
    const removalPolicy = props.isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    // KMS key for PHI data (DynamoDB, S3 objects)
    this.phiKey = new kms.Key(this, 'PhiKey', {
      alias: 'eob-extractor/phi',
      description: 'Encrypts PHI data in DynamoDB and S3',
      enableKeyRotation: true,
      removalPolicy,
    });

    // KMS key for audit logs (CloudWatch, audit S3 bucket)
    this.auditKey = new kms.Key(this, 'AuditKey', {
      alias: 'eob-extractor/audit',
      description: 'Encrypts audit logs in CloudWatch and S3',
      enableKeyRotation: true,
      removalPolicy,
    });

    // CloudWatch Logs needs permission to use the audit KMS key
    this.auditKey.addToResourcePolicy(new iam.PolicyStatement({
      actions: [
        'kms:Encrypt*',
        'kms:Decrypt*',
        'kms:ReEncrypt*',
        'kms:GenerateDataKey*',
        'kms:Describe*',
      ],
      principals: [new iam.ServicePrincipal(`logs.${cdk.Stack.of(this).region}.amazonaws.com`)],
      resources: ['*'],
      conditions: {
        ArnLike: {
          'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${cdk.Stack.of(this).region}:${account}:log-group:*`,
        },
      },
    }));

    // Import existing S3 bucket (bucket-specialops-sandbox or bucket-specialops)
    this.eobBucket = s3.Bucket.fromBucketName(this, 'EobBucket', props.bucketName);

    // Audit bucket with Object Lock (COMPLIANCE mode, 6-year retention)
    this.auditBucket = new s3.Bucket(this, 'AuditBucket', {
      bucketName: `eob-extractor-audit-${account}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.auditKey,
      objectLockEnabled: true,
      objectLockDefaultRetention: s3.ObjectLockRetention.compliance(
        cdk.Duration.days(2190), // 6 years
      ),
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy,
      lifecycleRules: [
        {
          id: 'transition-to-ia',
          transitions: [
            { storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: cdk.Duration.days(90) },
            { storageClass: s3.StorageClass.GLACIER, transitionAfter: cdk.Duration.days(365) },
          ],
        },
      ],
    });

    // DynamoDB table for EOB extractions
    this.extractionsTable = new dynamodb.Table(this, 'ExtractionsTable', {
      tableName: 'eob-extractions',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.phiKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: props.isProd,
      removalPolicy,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      timeToLiveAttribute: 'ttl',
    });

    // GSI: Query by status (pending reviews, failures)
    // NOTE: ProjectionType.ALL copies rawExtractionJson into the index (cost overhead).
    // Changing to INCLUDE requires GSI recreation under a new name — deferred migration.
    this.extractionsTable.addGlobalSecondaryIndex({
      indexName: 'GSI-Status',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'extractedAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI: Lookup by claim number
    // NOTE: 'claimNumber' attribute is not currently written by any handler — index is empty.
    // NOTE: ProjectionType.ALL — deferred migration to INCLUDE (same reason as GSI-Status).
    this.extractionsTable.addGlobalSecondaryIndex({
      indexName: 'GSI-ClaimNumber',
      partitionKey: { name: 'claimNumber', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'extractedAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI: Analytics by insurer
    // NOTE: items use 'insuranceName' (not 'insurerName') — index is empty until aligned.
    // NOTE: ProjectionType.ALL — deferred migration to INCLUDE (same reason as GSI-Status).
    this.extractionsTable.addGlobalSecondaryIndex({
      indexName: 'GSI-Insurer',
      partitionKey: { name: 'insurerName', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'extractedAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI: O(1) deduplication check by S3 object key
    this.extractionsTable.addGlobalSecondaryIndex({
      indexName: 'GSI-S3Key',
      partitionKey: { name: 's3Key', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });
  }
}
