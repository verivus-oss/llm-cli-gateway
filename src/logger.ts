export interface Logger {
  info(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  debug(message: string, meta?: unknown): void;
}

export const noopLogger: Logger = {
  info: () => {},
  error: () => {},
  debug: () => {},
};
