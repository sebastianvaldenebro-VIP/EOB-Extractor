import * as cdk from 'aws-cdk-lib/core';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface DashboardConstructProps {
  readonly stateMachine: sfn.StateMachine;
  readonly ingestQueue: sqs.Queue;
  readonly reviewQueue: sqs.Queue;
  readonly dlq: sqs.Queue;
}

/** Lambda function names matching those defined in ExtractionConstruct */
const LAMBDA_FUNCTION_NAMES = [
  'eob-validate-pdf',
  'eob-classify-eob',
  'eob-extract-eob',
  'eob-validate-data',
  'eob-lookup-insurance',
  'eob-store-result',
  'eob-trigger',
] as const;

export class DashboardConstruct extends Construct {
  public readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: DashboardConstructProps) {
    super(scope, id);

    this.dashboard = new cloudwatch.Dashboard(this, 'PipelineDashboard', {
      dashboardName: 'eob-extractor-pipeline',
      defaultInterval: cdk.Duration.hours(6),
    });

    this.dashboard.addWidgets(
      ...this.createStepFunctionsWidgets(props.stateMachine),
    );

    this.dashboard.addWidgets(
      ...this.createLambdaInvocationWidgets(),
    );

    this.dashboard.addWidgets(
      ...this.createLambdaDurationWidgets(),
    );

    this.dashboard.addWidgets(
      ...this.createSqsWidgets(props.ingestQueue, props.reviewQueue, props.dlq),
    );

    this.dashboard.addWidgets(
      ...this.createBedrockWidgets(),
    );
  }

  // ---------------------------------------------------------------------------
  // Step Functions: executions started, succeeded, failed, timed out
  // ---------------------------------------------------------------------------
  private createStepFunctionsWidgets(stateMachine: sfn.StateMachine): cloudwatch.IWidget[] {
    const sfnMetric = (metricName: string): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: 'AWS/States',
        metricName,
        dimensionsMap: {
          StateMachineArn: stateMachine.stateMachineArn,
        },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      });

    return [
      new cloudwatch.GraphWidget({
        title: 'Step Functions — Execution Counts',
        width: 24,
        height: 8,
        stacked: true,
        left: [
          sfnMetric('ExecutionsStarted'),
          sfnMetric('ExecutionsSucceeded'),
          sfnMetric('ExecutionsFailed'),
          sfnMetric('ExecutionsTimedOut'),
        ],
      }),
    ];
  }

  // ---------------------------------------------------------------------------
  // Lambda: invocations + errors for all 7 functions
  // ---------------------------------------------------------------------------
  private createLambdaInvocationWidgets(): cloudwatch.IWidget[] {
    const lambdaMetric = (functionName: string, metricName: string): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: 'AWS/Lambda',
        metricName,
        dimensionsMap: { FunctionName: functionName },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      });

    const invocationMetrics = LAMBDA_FUNCTION_NAMES.map((fn) =>
      lambdaMetric(fn, 'Invocations'),
    );

    const errorMetrics = LAMBDA_FUNCTION_NAMES.map((fn) =>
      lambdaMetric(fn, 'Errors'),
    );

    return [
      new cloudwatch.GraphWidget({
        title: 'Lambda — Invocations (all functions)',
        width: 12,
        height: 8,
        stacked: false,
        left: invocationMetrics,
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda — Errors (all functions)',
        width: 12,
        height: 8,
        stacked: false,
        left: errorMetrics,
      }),
    ];
  }

  // ---------------------------------------------------------------------------
  // Lambda: duration p50 / p99 for eob-extract-eob (the expensive Bedrock call)
  // ---------------------------------------------------------------------------
  private createLambdaDurationWidgets(): cloudwatch.IWidget[] {
    const extractDuration = (statistic: string): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: 'AWS/Lambda',
        metricName: 'Duration',
        dimensionsMap: { FunctionName: 'eob-extract-eob' },
        statistic,
        period: cdk.Duration.minutes(5),
      });

    return [
      new cloudwatch.GraphWidget({
        title: 'Lambda — eob-extract-eob Duration (p50 / p99)',
        width: 24,
        height: 6,
        left: [
          extractDuration('p50'),
          extractDuration('p99'),
        ],
        leftYAxis: {
          label: 'Duration (ms)',
          min: 0,
        },
      }),
    ];
  }

  // ---------------------------------------------------------------------------
  // SQS: messages visible for ingest, review, and DLQ
  // ---------------------------------------------------------------------------
  private createSqsWidgets(
    ingestQueue: sqs.Queue,
    reviewQueue: sqs.Queue,
    dlq: sqs.Queue,
  ): cloudwatch.IWidget[] {
    const queueMetric = (queue: sqs.Queue, label: string): cloudwatch.Metric =>
      queue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
        statistic: 'Maximum',
        label,
      });

    return [
      new cloudwatch.GraphWidget({
        title: 'SQS — Messages Visible',
        width: 24,
        height: 6,
        left: [
          queueMetric(ingestQueue, 'Ingest Queue'),
          queueMetric(reviewQueue, 'Review Queue'),
          queueMetric(dlq, 'DLQ'),
        ],
        leftYAxis: {
          label: 'Messages',
          min: 0,
        },
      }),
    ];
  }

  // ---------------------------------------------------------------------------
  // Bedrock: model invocation count and latency
  // Uses AWS/Bedrock namespace which publishes metrics when models are invoked.
  // ---------------------------------------------------------------------------
  private createBedrockWidgets(): cloudwatch.IWidget[] {
    const bedrockInvocations = new cloudwatch.Metric({
      namespace: 'AWS/Bedrock',
      metricName: 'Invocations',
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
      label: 'Bedrock Invocations',
    });

    const bedrockLatency = new cloudwatch.Metric({
      namespace: 'AWS/Bedrock',
      metricName: 'InvocationLatency',
      statistic: 'Average',
      period: cdk.Duration.minutes(5),
      label: 'Bedrock Latency (avg)',
    });

    const bedrockLatencyP99 = new cloudwatch.Metric({
      namespace: 'AWS/Bedrock',
      metricName: 'InvocationLatency',
      statistic: 'p99',
      period: cdk.Duration.minutes(5),
      label: 'Bedrock Latency (p99)',
    });

    return [
      new cloudwatch.GraphWidget({
        title: 'Bedrock — Invocation Count',
        width: 12,
        height: 6,
        left: [bedrockInvocations],
      }),
      new cloudwatch.GraphWidget({
        title: 'Bedrock — Invocation Latency',
        width: 12,
        height: 6,
        left: [bedrockLatency, bedrockLatencyP99],
        leftYAxis: {
          label: 'Latency (ms)',
          min: 0,
        },
      }),
    ];
  }
}
