#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { EobExtractorStack } from '../lib/eob-extractor-stack';
import { PermissionBoundaryAspect } from '../lib/aspects/permission-boundary.aspect';

const app = new cdk.App();

const account = process.env.CDK_DEFAULT_ACCOUNT ?? app.node.tryGetContext('account');

const stack = new EobExtractorStack(app, 'EobExtractorStack', {
  env: {
    account,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  synthesizer: new cdk.CliCredentialsStackSynthesizer({
    fileAssetsBucketName: `cdk-hnb659fds-assets-${account}-us-east-1`,
    bucketPrefix: '',
    imageAssetsRepositoryName: `cdk-hnb659fds-container-assets-${account}-us-east-1`,
  }),
});

// Attach EngineeringPermissionBoundary to ALL IAM roles (including CDK auto-generated)
if (account) {
  cdk.Aspects.of(app).add(
    new PermissionBoundaryAspect(
      `arn:aws:iam::${account}:policy/EngineeringPermissionBoundary`,
    ),
  );
}
