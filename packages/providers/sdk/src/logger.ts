/**
 * Minimal structured logger contract (a subset of pino's API) so providers can
 * log without depending on a concrete logging library.
 *
 * NEVER log credentials. Providers receive tokens only through typed
 * `ProviderCredentials` objects and must not place them in log bindings.
 */
export interface ProviderLogger {
  debug(obj: Record<string, unknown>, msg?: string): void;
  debug(msg: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  info(msg: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  warn(msg: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  error(msg: string): void;
  child(bindings: Record<string, unknown>): ProviderLogger;
}

/** A logger that discards everything: handy for tests. */
export const noopLogger: ProviderLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
};
