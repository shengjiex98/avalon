export class GameError extends Error {
  key: string;
  params: Record<string, unknown>;

  constructor(key: string, params: Record<string, unknown> = {}) {
    super(key);
    this.key = key;
    this.params = params;
  }
}
