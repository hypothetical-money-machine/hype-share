/** Generic HTTP-shaped error for handlers that need a specific status. */
export class HttpError extends Error {
  override readonly name = "HttpError";
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
