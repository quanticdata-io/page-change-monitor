import { describe, expect, it } from 'vitest';
import { type Rule } from '../src/config.js';
import { changedFields, evaluateRules, toNumber } from '../src/rules.js';

const msgs = (before: Record<string, unknown>, after: Record<string, unknown>, rules?: Rule[]) => evaluateRules(before, after, rules).map((a) => a.message);

describe('toNumber', () => {
  it.each([
    [51.77, 51.77],
    ['£51.77', 51.77],
    ['$1,299.00', 1299],
    ['1.299,50 €', 1299.5],
    ['In stock (22 available)', 22],
    ['free', null],
    [null, null],
    [true, null],
  ])('%j -> %j', (input, expected) => {
    expect(toNumber(input)).toBe(expected);
  });
});

describe('evaluateRules', () => {
  it('without rules, alerts on every changed field', () => {
    expect(changedFields({ a: 1, b: 2 }, { a: 1, b: 3, c: 'x' }).map((c) => c.field)).toEqual(['b', 'c']);
    expect(msgs({ price: 51.77, stock: 'In stock' }, { price: 45, stock: 'In stock' })).toEqual(['price changed: 51.77 -> 45']);
  });

  it('decrease with a percent threshold', () => {
    const rules: Rule[] = [{ field: 'price', type: 'decrease', percent: 10 }];
    expect(msgs({ price: 100 }, { price: 95 }, rules)).toEqual([]);
    expect(msgs({ price: 100 }, { price: 85 }, rules)).toEqual(['price dropped: 100 -> 85 (-15.0%)']);
    expect(msgs({ price: 100 }, { price: 120 }, rules)).toEqual([]);
    expect(msgs({ price: '£100.00' }, { price: '£80.00' }, rules)).toEqual(['price dropped: 100 -> 80 (-20.0%)']);
  });

  it('increase with no threshold fires on any rise', () => {
    expect(msgs({ price: 10 }, { price: 10.5 }, [{ field: 'price', type: 'increase' }])).toEqual(['price rose: 10 -> 10.5 (+5.0%)']);
  });

  it('below and above fire when the threshold is crossed, not on every run', () => {
    const below: Rule[] = [{ field: 'price', type: 'below', value: 40 }];
    expect(msgs({ price: 45 }, { price: 39 }, below)).toEqual(['price is below 40: 39']);
    expect(msgs({ price: 39 }, { price: 38 }, below)).toEqual([]);
    expect(msgs({ price: 45 }, { price: 41 }, below)).toEqual([]);
    expect(msgs({ stock: 5 }, { stock: 50 }, [{ field: 'stock', type: 'above', value: 20 }])).toEqual(['stock is above 20: 50']);
  });

  it('contains and not_contains detect transitions, case-insensitive', () => {
    const back: Rule[] = [{ field: 'availability', type: 'contains', value: 'in stock' }];
    expect(msgs({ availability: 'Out of stock' }, { availability: 'In stock (3 available)' }, back)).toEqual([
      'availability now contains "in stock": "In stock (3 available)"',
    ]);
    expect(msgs({ availability: 'In stock (4 available)' }, { availability: 'In stock (3 available)' }, back)).toEqual([]);
    const gone: Rule[] = [{ field: 'availability', type: 'not_contains', value: 'In stock' }];
    expect(msgs({ availability: 'In stock' }, { availability: null }, gone)).toEqual(['availability no longer contains "In stock": (empty)']);
  });

  it('changed rule on one field ignores the others', () => {
    const rules: Rule[] = [{ field: 'availability', type: 'changed' }];
    expect(msgs({ price: 1, availability: 'a' }, { price: 2, availability: 'a' }, rules)).toEqual([]);
    expect(msgs({ price: 1, availability: 'a' }, { price: 1, availability: 'b' }, rules)).toEqual(['availability changed: "a" -> "b"']);
  });

  it('ignores numeric rules on non-numeric values', () => {
    expect(msgs({ price: 'n/a' }, { price: 'call us' }, [{ field: 'price', type: 'decrease' }])).toEqual([]);
  });
});
