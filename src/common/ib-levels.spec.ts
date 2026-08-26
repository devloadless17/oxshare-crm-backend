import { describe, expect, it } from 'vitest';
import { ABSOLUTE_IB_MAX_LEVELS, DEFAULT_IB_MAX_LEVELS, normaliseIbMaxLevels } from './ib-levels';

/**
 * The ladder ceiling, as a pure function.
 *
 * ## What is actually at stake
 *
 * This number decides how deep a commission programme may go, which decides how
 * many partners a single trade pays. Getting it wrong in either direction is a
 * money problem rather than a correctness one:
 *
 *  - too HIGH and a deployment quietly pays out more than the broker committed
 *    to, with nothing reporting it;
 *  - too LOW and a broker who negotiated a third level cannot configure it.
 *
 * The committed scope is TWO — Feature List Rev 9, IB-17, "no level beyond L2"
 * — so every uncertain case here resolves to 2 rather than to the maximum. A
 * bad row must not widen what partners are paid.
 *
 * A normaliser over a plain number rather than a database read, so every
 * boundary case is one assertion with no container — and so this can live in
 * `common/`, which lint forbids from importing `modules/`.
 */
describe('the configured ladder ceiling', () => {
  it('defaults to the committed two levels when there is no row', () => {
    /*
     * `null` is what a platform with no settings row reads as — nobody has
     * opened the Trading tab yet. It must ship the agreed scope, not a guess.
     */
    expect(normaliseIbMaxLevels(undefined)).toBe(2);
    expect(normaliseIbMaxLevels(null)).toBe(2);
    expect(DEFAULT_IB_MAX_LEVELS).toBe(2);
  });

  it('takes a number the operator deliberately saved', () => {
    expect(normaliseIbMaxLevels(1)).toBe(1);
    expect(normaliseIbMaxLevels(3)).toBe(3);
    expect(normaliseIbMaxLevels(10)).toBe(10);
  });

  /*
   * ZERO is not a ceiling anybody is trying to express, unlike the account caps
   * beside it on the same form where 0 means "stop opening new ones". Here it
   * would make every commission-paying programme unsaveable.
   */
  it('refuses a ceiling of zero', () => {
    expect(normaliseIbMaxLevels(0)).toBe(DEFAULT_IB_MAX_LEVELS);
    expect(normaliseIbMaxLevels(-1)).toBe(DEFAULT_IB_MAX_LEVELS);
  });

  /*
   * ⚠️ THE DIRECTION THAT MATTERS.
   *
   * A malformed value falls back to the DEFAULT, never to the maximum. Falling
   * back to 10 would let a typo widen what partners are paid — a scope change
   * caused by a fat finger, announced by nothing. Falling back to 2 keeps a
   * broken deployment on the terms that were actually agreed.
   */
  it('falls back to the committed default on an unusable value, never to the maximum', () => {
    /*
     * A fraction cannot be a number of levels. It reaches here only from a
     * restored dump or a hand-written row — the CHECK and the DTO both stop it
     * — and rounding it would invent a ceiling nobody chose.
     */
    for (const bad of [2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(normaliseIbMaxLevels(bad), `${String(bad)} should fall back`).toBe(
        DEFAULT_IB_MAX_LEVELS,
      );
    }
  });

  /*
   * Above the DATABASE's own bound is refused rather than clamped.
   *
   * `ib_program_tiers_depth_range` is 1..10. Clamping 20 to 10 silently would
   * be defensible; clamping it to 10 while an operator believed they had set 20
   * is the console-versus-engine disagreement this whole setting exists to end.
   * Falling back to the default makes the misconfiguration visible as terms
   * that are obviously not what was typed.
   */
  it('refuses a value the database could not store', () => {
    expect(ABSOLUTE_IB_MAX_LEVELS).toBe(10);
    expect(normaliseIbMaxLevels(11)).toBe(DEFAULT_IB_MAX_LEVELS);
    expect(normaliseIbMaxLevels(99)).toBe(DEFAULT_IB_MAX_LEVELS);
  });
});
