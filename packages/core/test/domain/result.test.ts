import { describe, expect, it } from 'vitest';

import { domainError, ERROR_CODES } from '../../src/domain/errors';
import {
  andThen,
  collect,
  err,
  isErr,
  isOk,
  map,
  mapErr,
  ok,
  unwrap,
  unwrapOr,
  type Result,
} from '../../src/domain/result';

const boom = domainError('E_CYCLE', 'adding this edge would create a cycle');

describe('Result', () => {
  it('narrows through the guards', () => {
    const good: Result<number> = ok(2);
    const bad: Result<number> = err(boom);
    expect(isOk(good) && good.value).toBe(2);
    expect(isErr(bad) && bad.error.code).toBe('E_CYCLE');
    expect(isOk(bad)).toBe(false);
    expect(isErr(good)).toBe(false);
  });

  it('map transforms only Ok', () => {
    expect(map(ok(2), (n) => n * 2)).toEqual(ok(4));
    expect(map(err(boom), (n: number) => n * 2)).toEqual(err(boom));
  });

  it('mapErr transforms only Err', () => {
    expect(mapErr(ok(2), () => boom)).toEqual(ok(2));
    expect(
      mapErr(err(boom), (e) => domainError(e.code, 'rewrapped')),
    ).toEqual(err(domainError('E_CYCLE', 'rewrapped')));
  });

  it('andThen chains and short-circuits', () => {
    const half = (n: number): Result<number> =>
      n % 2 === 0 ? ok(n / 2) : err(boom);
    expect(andThen(ok(4), half)).toEqual(ok(2));
    expect(andThen(ok(3), half)).toEqual(err(boom));
    expect(andThen(err(boom), half)).toEqual(err(boom));
  });

  it('unwrapOr falls back on Err', () => {
    expect(unwrapOr(ok(2), 0)).toBe(2);
    expect(unwrapOr(err(boom), 0)).toBe(0);
  });

  it('unwrap throws TypeError on Err (never silently)', () => {
    expect(unwrap(ok('fine'))).toBe('fine');
    expect(() => unwrap(err(boom))).toThrow(TypeError);
  });

  it('collect gathers values or returns the first error', () => {
    expect(collect([ok(1), ok(2), ok(3)])).toEqual(ok([1, 2, 3]));
    const second = domainError('E_PARSE', 'second');
    expect(collect<number, unknown>([ok(1), err(second), err(boom)])).toEqual(
      err(second),
    );
  });
});

describe('domainError', () => {
  it('builds frozen-shape errors with optional details', () => {
    expect(domainError('E_MAX_VISIONS', 'limit is 4')).toEqual({
      code: 'E_MAX_VISIONS',
      message: 'limit is 4',
    });
    expect(domainError('E_PARSE', 'bad', { issue: 'x' })).toEqual({
      code: 'E_PARSE',
      message: 'bad',
      details: { issue: 'x' },
    });
  });

  it('the catalog covers every §6.7 invariant code', () => {
    for (const code of [
      'E_HIERARCHY',
      'E_MAX_VISIONS',
      'E_JUSTIFICATION',
      'E_CYCLE',
      'E_EDGE_TYPE_MISMATCH',
      'E_TIMER_ALREADY_RUNNING',
      'E_INVALID_INTERVAL',
      'E_ANCHORED_IMMUTABLE',
      'E_DONE_IMMUTABLE',
      'E_SUGGESTION_OVERLAPS_ANCHOR',
    ]) {
      expect(ERROR_CODES).toContain(code);
    }
  });
});
