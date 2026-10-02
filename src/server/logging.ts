export type LogFields = Record<string, string | number | boolean | null>;
export type LogLevel = 'info' | 'error';
export type OperationalLogger = (
  level: LogLevel,
  event: string,
  fields?: LogFields,
) => void;

export type OperationalLogRecord = {
  sequence: number;
  time: string;
  level: LogLevel;
  event: string;
  fields: LogFields;
};

export type LogView = 'activity' | 'problems' | 'requests' | 'all';

type RecentLogsOptions = {
  activityCapacity?: number;
  requestCapacity?: number;
  now?: () => number;
};

/** Keep request volume from evicting the lifecycle and failure trail. */
export class RecentLogs {
  private readonly activity: OperationalLogRecord[] = [];
  private readonly requests: OperationalLogRecord[] = [];
  private readonly activityCapacity: number;
  private readonly requestCapacity: number;
  private readonly now: () => number;
  private sequence = 0;

  constructor({
    activityCapacity = 200,
    requestCapacity = 300,
    now = Date.now,
  }: RecentLogsOptions = {}) {
    this.activityCapacity = Math.max(1, Math.floor(activityCapacity));
    this.requestCapacity = Math.max(1, Math.floor(requestCapacity));
    this.now = now;
  }

  append(level: LogLevel, event: string, fields: LogFields = {}): void {
    const record: OperationalLogRecord = {
      sequence: ++this.sequence,
      time: new Date(this.now()).toISOString(),
      level,
      event,
      fields: { ...fields },
    };
    const target = event === 'api.request' ? this.requests : this.activity;
    const capacity = event === 'api.request' ? this.requestCapacity : this.activityCapacity;
    target.push(record);
    if (target.length > capacity) target.splice(0, target.length - capacity);
  }

  recent(view: LogView = 'activity', limit = 50): OperationalLogRecord[] {
    const candidates = view === 'activity' ? [...this.activity]
      : view === 'requests' ? [...this.requests]
        : [...this.activity, ...this.requests];
    return candidates
      .filter((record) => view !== 'problems' || logTone(record) === 'error' || logTone(record) === 'warn')
      .sort((left, right) => right.sequence - left.sequence)
      .slice(0, Math.max(0, Math.floor(limit)))
      .map((record) => ({ ...record, fields: { ...record.fields } }));
  }
}

export type LogTone = 'error' | 'warn' | 'ok' | 'info';

export function logTone(record: OperationalLogRecord): LogTone {
  const status = typeof record.fields.status === 'number' ? record.fields.status : null;
  if (record.level === 'error' || (status !== null && status >= 500)) return 'error';
  if ((status !== null && status >= 400)
      || (record.event === 'snapshot.load' && record.fields.outcome === 'discarded')) return 'warn';
  if (record.event === 'api.request' && status !== null && status < 400) return 'ok';
  return 'info';
}

export function captureLogs(logs: RecentLogs, sink: OperationalLogger): OperationalLogger {
  return (level, event, fields = {}) => {
    logs.append(level, event, fields);
    sink(level, event, fields);
  };
}

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
