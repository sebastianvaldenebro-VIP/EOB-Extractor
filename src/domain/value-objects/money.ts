export class Money {
  private constructor(private readonly _amount: number) {
    if (!Number.isFinite(_amount)) {
      throw new Error('Money amount must be a finite number');
    }
  }

  get amount(): number {
    return this._amount;
  }

  static fromNumber(value: number): Money {
    return new Money(Math.round(value * 100) / 100);
  }

  static fromString(value: string): Money {
    const parsed = parseFloat(value);
    if (Number.isNaN(parsed)) {
      throw new Error(`Invalid monetary value: "${value}"`);
    }
    return Money.fromNumber(parsed);
  }

  static zero(): Money {
    return new Money(0);
  }

  add(other: Money): Money {
    return new Money(Math.round((this._amount + other._amount) * 100) / 100);
  }

  subtract(other: Money): Money {
    return new Money(Math.round((this._amount - other._amount) * 100) / 100);
  }

  isNegative(): boolean {
    return this._amount < 0;
  }

  isZero(): boolean {
    return this._amount === 0;
  }

  equals(other: Money): boolean {
    return this._amount === other._amount;
  }

  toString(): string {
    return this._amount.toFixed(2);
  }
}
