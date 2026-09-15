/**
 * "Too many failed sign-in attempts. Try again in …" — the words, in one place.
 *
 * Both surfaces raise this and both said `${minutes} minute(s)`. That bracketed
 * plural is a shorthand developers read past and nobody else does: it is the
 * sign of a string assembled by a program rather than written for a person, on
 * the one screen where somebody is already anxious about their own money and
 * unsure whether the problem is them.
 *
 * It also rounded a 40-second wait up to "1 minute(s)", which is both ungrammatical
 * and an overstatement — a person who waits the minute they were told to wait and
 * is then let in at 40 seconds lost twenty seconds to a rounding choice.
 *
 * Seconds under a minute, minutes above it, and a real plural either way. Same
 * rule as `rateLimitMessage` in `all-exceptions.filter.ts`, deliberately: these
 * two are the errors ordinary clients actually meet, they appear in the same red
 * box on the same form, and reading differently from one another is how a product
 * looks assembled rather than built.
 */
export function lockoutMessage(lockedForMs: number): string {
  const seconds = Math.ceil(lockedForMs / 1000);

  if (seconds < 60) {
    return `Too many failed sign-in attempts. Please try again in ${seconds} second${
      seconds === 1 ? '' : 's'
    }.`;
  }

  const minutes = Math.ceil(seconds / 60);
  return `Too many failed sign-in attempts. Please try again in ${minutes} minute${
    minutes === 1 ? '' : 's'
  }.`;
}
