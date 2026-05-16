export class OverleafAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverleafAuthError";
  }
}

export class OverleafApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, hint?: string) {
    super(`Overleaf API error ${status}${hint ? ` (${hint})` : ""}: ${body.slice(0, 200)}`);
    this.name = "OverleafApiError";
    this.status = status;
    this.body = body;
  }
}
