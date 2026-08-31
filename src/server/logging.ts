export type LogFields = Record<string, string | number | boolean | null>;
export type OperationalLogger = (
  level: 'info' | 'error',
  event: string,
  fields?: LogFields,
) => void;

/** Keep the transport boring: systemd already owns collection and retention. */
export const operationalLogger: OperationalLogger = (level, event, fields = {}) => {
  const record = JSON.stringify({
    time: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  if (level === 'error') console.error(record);
  else console.log(record);
};

/** Error messages can contain room codes or other input, so log only their kind. */
export function errorKind(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : 'Error';
}
