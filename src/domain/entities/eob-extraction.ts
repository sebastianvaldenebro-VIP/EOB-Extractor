import { ulid } from 'ulid';
import { ConfidenceScore } from '../value-objects/confidence-score';
import { ExtractionStatus, extractionStatusFromConfidence } from '../value-objects/extraction-status';

export interface EobExtractionProps {
  readonly extractionId?: string;
  readonly taskId: string;
  readonly s3Key: string;
  readonly s3VersionId: string | null;
  readonly status: ExtractionStatus;
  readonly confidenceScore: ConfidenceScore;
  readonly insuranceName: string | null;
  readonly insuranceIdentifier: string | null;
  readonly address: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly zipCode: string | null;
  readonly locationState: string | null;
  readonly arbitrationPhone: string | null;
  readonly arbitrationFax: string | null;
  readonly arbitrationEmail: string | null;
  readonly rawExtractionJson: string;
  readonly modelId: string;
  readonly classificationResult: string | null;
  readonly extractedAt: string;
  readonly processingDurationMs: number;
  readonly correlationId: string;
}

export class EobExtraction {
  readonly extractionId: string;
  readonly taskId: string;
  readonly s3Key: string;
  readonly s3VersionId: string | null;
  readonly status: ExtractionStatus;
  readonly confidenceScore: ConfidenceScore;
  readonly insuranceName: string | null;
  readonly insuranceIdentifier: string | null;
  readonly address: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly zipCode: string | null;
  readonly locationState: string | null;
  readonly arbitrationPhone: string | null;
  readonly arbitrationFax: string | null;
  readonly arbitrationEmail: string | null;
  readonly rawExtractionJson: string;
  readonly modelId: string;
  readonly classificationResult: string | null;
  readonly extractedAt: string;
  readonly processingDurationMs: number;
  readonly correlationId: string;

  private constructor(props: EobExtractionProps) {
    this.extractionId = props.extractionId ?? ulid();
    this.taskId = props.taskId;
    this.s3Key = props.s3Key;
    this.s3VersionId = props.s3VersionId;
    this.status = props.status;
    this.confidenceScore = props.confidenceScore;
    this.insuranceName = props.insuranceName;
    this.insuranceIdentifier = props.insuranceIdentifier;
    this.address = props.address;
    this.city = props.city;
    this.state = props.state;
    this.zipCode = props.zipCode;
    this.locationState = props.locationState;
    this.arbitrationPhone = props.arbitrationPhone;
    this.arbitrationFax = props.arbitrationFax;
    this.arbitrationEmail = props.arbitrationEmail;
    this.rawExtractionJson = props.rawExtractionJson;
    this.modelId = props.modelId;
    this.classificationResult = props.classificationResult;
    this.extractedAt = props.extractedAt;
    this.processingDurationMs = props.processingDurationMs;
    this.correlationId = props.correlationId;
  }

  static create(props: EobExtractionProps): EobExtraction {
    return new EobExtraction(props);
  }

  static createFromExtraction(
    taskId: string,
    s3Key: string,
    s3VersionId: string | null,
    confidenceScore: ConfidenceScore,
    rawJson: string,
    modelId: string,
    classificationResult: string | null,
    processingDurationMs: number,
    correlationId: string,
    fields: Pick<
      EobExtractionProps,
      | 'insuranceName'
      | 'insuranceIdentifier'
      | 'address'
      | 'city'
      | 'state'
      | 'zipCode'
      | 'locationState'
      | 'arbitrationPhone'
      | 'arbitrationFax'
      | 'arbitrationEmail'
    >,
  ): EobExtraction {
    return new EobExtraction({
      taskId,
      s3Key,
      s3VersionId,
      status: extractionStatusFromConfidence(confidenceScore),
      confidenceScore,
      rawExtractionJson: rawJson,
      modelId,
      classificationResult,
      extractedAt: new Date().toISOString(),
      processingDurationMs,
      correlationId,
      ...fields,
    });
  }
}
