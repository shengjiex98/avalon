
/** A missing case stays a compile error and becomes an explicit runtime fault. */
export function assertNever(value: never, message?: string): never {
  throw new Error(message ?? `unexpected discriminant: ${String(value)}`);
}
