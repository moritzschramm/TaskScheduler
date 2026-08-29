/**
 * What a command can be refused for (spec §7).
 *
 * Every command has a precondition; these are the ways one fails. They are
 * distinct types rather than one error with a string, because M9 has to map
 * them onto different HTTP statuses and a client has to react differently to
 * each: a version conflict is worth retrying after a refresh, a precondition
 * failure is not.
 */
export abstract class CommandError extends Error {
  /** Stable identifier, safe to branch on and to show through an API. */
  abstract readonly code: string;
}

/** The command's shape or parameters are not something the vocabulary allows. */
export class CommandValidationError extends CommandError {
  readonly code = 'invalid_command';

  constructor(
    message: string,
    readonly issues: readonly { path: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'CommandValidationError';
  }
}

/** The command names something that does not exist in this tenant context. */
export class EntityNotFoundError extends CommandError {
  readonly code = 'not_found';

  constructor(
    readonly entity: string,
    readonly id: string,
  ) {
    super(`No ${entity} ${id} in this context`);
    this.name = 'EntityNotFoundError';
  }
}

/**
 * The target changed since the client last read it (spec §5.4).
 *
 * Reported with both versions so a client can tell "someone else edited this"
 * from "my own earlier write has not landed yet".
 */
export class OptimisticLockError extends CommandError {
  readonly code = 'version_conflict';

  constructor(
    readonly entity: string,
    readonly id: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `${entity} ${id} is at version ${actualVersion}, but the command expected ${expectedVersion}`,
    );
    this.name = 'OptimisticLockError';
  }
}

/** The world is not in the state this command requires. */
export class PreconditionFailedError extends CommandError {
  readonly code = 'precondition_failed';

  constructor(message: string) {
    super(message);
    this.name = 'PreconditionFailedError';
  }
}
