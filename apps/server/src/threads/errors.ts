// Named errors raised at the thread store boundary. Callers switch on `code`
// (or instanceof); no SQLite error text leaks out for the expected cases.

export class ThreadNotFoundError extends Error {
  override readonly name = "ThreadNotFoundError";
  readonly code = "thread-not-found";
  readonly threadId: string;
  constructor(threadId: string) {
    super(`thread not found: ${threadId}`);
    this.threadId = threadId;
  }
}

export class DuplicateMessageError extends Error {
  override readonly name = "DuplicateMessageError";
  readonly code = "duplicate-message";
  readonly messageId: string;
  constructor(messageId: string) {
    super(`message already stored: ${messageId}`);
    this.messageId = messageId;
  }
}

export class InvalidInputError extends Error {
  override readonly name = "InvalidInputError";
  readonly code = "invalid-input";
  readonly field: string;
  constructor(field: string, problem: string) {
    super(`invalid ${field}: ${problem}`);
    this.field = field;
  }
}

export class StoreVersionTooNewError extends Error {
  override readonly name = "StoreVersionTooNewError";
  readonly code = "store-version-too-new";
  readonly found: number;
  readonly supported: number;
  readonly dbPath: string;
  constructor(dbPath: string, found: number, supported: number) {
    super(
      `thread database ${dbPath} is at schema version ${found}; this build knows up to ${supported}. ` +
        `Refusing to open it so a newer app's data is not damaged.`,
    );
    this.dbPath = dbPath;
    this.found = found;
    this.supported = supported;
  }
}

export class StoreClosedError extends Error {
  override readonly name = "StoreClosedError";
  readonly code = "store-closed";
  constructor() {
    super("thread store is closed");
  }
}

export class TurnBufferClosedError extends Error {
  override readonly name = "TurnBufferClosedError";
  readonly code = "turn-buffer-closed";
  readonly state: string;
  constructor(state: string) {
    super(`turn buffer is ${state}; it takes no more deltas`);
    this.state = state;
  }
}
