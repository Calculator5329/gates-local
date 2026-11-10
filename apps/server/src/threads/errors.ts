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

export class StoreCopyError extends Error {
  override readonly name = "StoreCopyError";
  readonly code = "store-copy-failed";
  readonly dbPath: string;
  constructor(dbPath: string, cause: unknown, action: string) {
    const code = cause instanceof Error && "code" in cause ? cause.code : undefined;
    const sqliteCode = cause instanceof Error && "errcode" in cause && typeof cause.errcode === "number" ? cause.errcode & 0xff : undefined;
    const full = code === "ENOSPC" || code === "EDQUOT" || sqliteCode === 13;
    // SQLITE_BUSY: another process held the store past the busy timeout.
    const busy = sqliteCode === 5;
    const reason = full ? "the disk is full"
      : busy ? "another program, most likely another copy of Gates Local, is using your chats"
      : code === "EACCES" || code === "EPERM" || sqliteCode === 3 ? "permission to save the copy was denied"
      : code === "EROFS" || sqliteCode === 8 ? "the disk is read-only"
      : code === "EIO" || sqliteCode === 10 ? "the disk could not read or write the copy"
      : action;
    super(
      `Gates Local could not save a copy of your chats before upgrading them, because ${reason}. ` +
      (full ? "Free some space and start it again. Nothing was changed."
        : busy ? "Close it and start Gates Local again. Nothing was changed."
        : "Check that the chat folder is writable and the disk is working, then start it again. Nothing was changed."),
      // The sentence above is for the person. The raw failure stays attached
      // and the server logs it at startup, naming the call and file that failed.
      { cause },
    );
    this.dbPath = dbPath;
  }
}

export class StoreClosedError extends Error {
  override readonly name = "StoreClosedError";
  readonly code = "store-closed";
  constructor() {
    super("thread store is closed");
  }
}
