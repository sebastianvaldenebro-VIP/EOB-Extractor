import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import { IConstruct } from 'constructs';

/**
 * CDK Aspect that attaches the EngineeringPermissionBoundary to every IAM role
 * in the construct tree — including CDK auto-generated roles.
 * Ported from ENLO app.py PermissionBoundaryAspect.
 */
export class PermissionBoundaryAspect implements cdk.IAspect {
  private readonly boundaryArn: string;

  constructor(boundaryArn: string) {
    this.boundaryArn = boundaryArn;
  }

  visit(node: IConstruct): void {
    if (node instanceof iam.CfnRole) {
      node.permissionsBoundary = this.boundaryArn;
    }
  }
}
