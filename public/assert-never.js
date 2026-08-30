// @ts-check

/**
 * A missing case stays a compile error and becomes an explicit runtime fault.
 * @param {never} value
 * @param {string} [message]
 */
export function assertNever(value, message) {
  throw new Error(message ?? `unexpected discriminant: ${String(value)}`);
}
