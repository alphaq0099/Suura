/**
 * Wraps a user's search term for a `LIKE` query, escaping its wildcards.
 *
 * The term is matched in the middle of a value, so both sides get `%`. The
 * escape character is the default backslash, which means every query using the
 * result also needs `ESCAPE '\'`.
 */
export function likeTerm(input: string): string {
  return `%${input.replace(/[\\%_]/g, '\\$&')}%`
}
