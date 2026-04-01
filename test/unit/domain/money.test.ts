import { Money } from '../../../src/domain/value-objects/money';

describe('Money', () => {
  describe('fromNumber', () => {
    it('creates valid money from a number', () => {
      const money = Money.fromNumber(10.99);
      expect(money.amount).toBe(10.99);
    });

    it('rounds to two decimal places', () => {
      const money = Money.fromNumber(10.999);
      expect(money.amount).toBe(11);
    });

    it('throws on non-finite values', () => {
      expect(() => Money.fromNumber(Infinity)).toThrow('Money amount must be a finite number');
      expect(() => Money.fromNumber(NaN)).toThrow('Money amount must be a finite number');
    });
  });

  describe('fromString', () => {
    it('parses a decimal string', () => {
      const money = Money.fromString('25.50');
      expect(money.amount).toBe(25.5);
    });

    it('parses an integer string', () => {
      const money = Money.fromString('100');
      expect(money.amount).toBe(100);
    });

    it('throws on non-numeric strings', () => {
      expect(() => Money.fromString('abc')).toThrow('Invalid monetary value: "abc"');
    });
  });

  describe('zero', () => {
    it('returns a Money with amount 0', () => {
      const money = Money.zero();
      expect(money.amount).toBe(0);
      expect(money.isZero()).toBe(true);
    });
  });

  describe('add', () => {
    it('adds two Money values correctly', () => {
      const a = Money.fromNumber(10.25);
      const b = Money.fromNumber(5.75);
      expect(a.add(b).amount).toBe(16);
    });

    it('handles floating-point precision', () => {
      const a = Money.fromNumber(0.1);
      const b = Money.fromNumber(0.2);
      expect(a.add(b).amount).toBe(0.3);
    });
  });

  describe('subtract', () => {
    it('subtracts two Money values correctly', () => {
      const a = Money.fromNumber(10);
      const b = Money.fromNumber(3.50);
      expect(a.subtract(b).amount).toBe(6.5);
    });

    it('can produce negative results', () => {
      const a = Money.fromNumber(5);
      const b = Money.fromNumber(10);
      expect(a.subtract(b).amount).toBe(-5);
    });
  });

  describe('isNegative', () => {
    it('returns true for negative amounts', () => {
      const money = Money.fromNumber(-1);
      expect(money.isNegative()).toBe(true);
    });

    it('returns false for zero', () => {
      expect(Money.zero().isNegative()).toBe(false);
    });

    it('returns false for positive amounts', () => {
      expect(Money.fromNumber(1).isNegative()).toBe(false);
    });
  });

  describe('equals', () => {
    it('returns true for equal amounts', () => {
      const a = Money.fromNumber(10.50);
      const b = Money.fromNumber(10.50);
      expect(a.equals(b)).toBe(true);
    });

    it('returns false for different amounts', () => {
      const a = Money.fromNumber(10);
      const b = Money.fromNumber(20);
      expect(a.equals(b)).toBe(false);
    });
  });

  describe('toString', () => {
    it('formats with two decimal places', () => {
      expect(Money.fromNumber(10).toString()).toBe('10.00');
      expect(Money.fromNumber(10.5).toString()).toBe('10.50');
    });
  });
});
