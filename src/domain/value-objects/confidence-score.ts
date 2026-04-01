const HIGH_THRESHOLD = 0.85;
const MEDIUM_THRESHOLD = 0.50;

export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW';

export class ConfidenceScore {
  private constructor(private readonly _value: number) {
    if (_value < 0 || _value > 1) {
      throw new Error(`Confidence score must be between 0 and 1, received: ${_value}`);
    }
  }

  get value(): number {
    return this._value;
  }

  get level(): ConfidenceLevel {
    if (this.isHighConfidence()) return 'HIGH';
    if (this.isMediumConfidence()) return 'MEDIUM';
    return 'LOW';
  }

  static fromNumber(value: number): ConfidenceScore {
    return new ConfidenceScore(value);
  }

  isHighConfidence(): boolean {
    return this._value >= HIGH_THRESHOLD;
  }

  isMediumConfidence(): boolean {
    return this._value >= MEDIUM_THRESHOLD && this._value < HIGH_THRESHOLD;
  }

  isLowConfidence(): boolean {
    return this._value < MEDIUM_THRESHOLD;
  }

  equals(other: ConfidenceScore): boolean {
    return this._value === other._value;
  }

  toString(): string {
    return `${this._value} (${this.level})`;
  }
}
