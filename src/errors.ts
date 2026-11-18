export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** The QuanticData API answered with an error, or the target could not be read. */
export class FetchError extends Error {
  override name = 'FetchError';
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** robots.txt disallows the URL for this tool's user agent (local engine). */
export class RobotsDisallowedError extends FetchError {
  override name = 'RobotsDisallowedError';
}
