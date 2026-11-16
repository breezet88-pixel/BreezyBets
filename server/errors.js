// One error type for everything a request handler can refuse.
// The server turns it into `{ error: code, message }` with the given HTTP status.
export class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}
export const bad = (msg, code = 'bad_request') => new HttpError(400, code, msg);
