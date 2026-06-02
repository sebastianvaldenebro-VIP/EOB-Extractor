import * as cdk from 'aws-cdk-lib/core';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';

export interface MonitoringConstructProps {
  readonly encryptionKey: kms.IKey;
  readonly dlq: sqs.Queue;
  readonly reviewQueue: sqs.Queue;
  readonly reviewDlq: sqs.Queue;
  readonly stateMachine?: sfn.StateMachine;
  readonly lambdaFunctions?: Record<string, lambda.Function>;
}

export class MonitoringConstruct extends Construct {
  public readonly opsAlertTopic: sns.Topic;
  public readonly reviewAlertTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: MonitoringConstructProps) {
    super(scope, id);

    // SNS topic for ops alerts (DLQ, failures)
    this.opsAlertTopic = new sns.Topic(this, 'OpsAlertTopic', {
      topicName: 'eob-extractor-ops-alerts',
      masterKey: props.encryptionKey,
    });

    // SNS topic for review alerts (low-confidence extractions)
    this.reviewAlertTopic = new sns.Topic(this, 'ReviewAlertTopic', {
      topicName: 'eob-extractor-review-alerts',
      masterKey: props.encryptionKey,
    });

    // Alarm: DLQ has messages (permanent failures)
    const dlqAlarm = new cloudwatch.Alarm(this, 'DlqMessagesAlarm', {
      alarmName: 'eob-extractor-dlq-messages',
      alarmDescription: 'EOB Extractor DLQ has messages — permanent extraction failures',
      metric: props.dlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    dlqAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(this.opsAlertTopic));

    // Alarm: Review queue growing (low-confidence backlog)
    const reviewAlarm = new cloudwatch.Alarm(this, 'ReviewQueueAlarm', {
      alarmName: 'eob-extractor-review-backlog',
      alarmDescription: 'EOB Extractor review queue backlog growing — low-confidence extractions need attention',
      metric: props.reviewQueue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(15),
        statistic: 'Sum',
      }),
      threshold: 10,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    reviewAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(this.reviewAlertTopic));

    // Alarm: Review DLQ has messages — PHI messages that failed all review queue delivery attempts
    const reviewDlqAlarm = new cloudwatch.Alarm(this, 'ReviewDlqMessagesAlarm', {
      alarmName: 'eob-extractor-review-dlq-messages',
      alarmDescription: 'EOB Extractor review DLQ has messages — PHI messages failed delivery',
      metric: props.reviewDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    reviewDlqAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(this.opsAlertTopic));
  }
}
