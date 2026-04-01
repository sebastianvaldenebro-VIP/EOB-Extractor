import { EobExtraction } from '../entities/eob-extraction';

export interface EobExtractionRepository {
  save(extraction: EobExtraction): Promise<void>;
  findByTaskId(taskId: string): Promise<readonly EobExtraction[]>;
  findByExtractionId(taskId: string, extractionId: string): Promise<EobExtraction | null>;
  existsByS3Key(s3Key: string): Promise<boolean>;
}
