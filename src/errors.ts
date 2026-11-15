/**
 * Every error this package throws is an `AcledaError`, so one `instanceof` catches them all. The PHP
 * twin throws the same as `AcledaException`, `AcledaRefusedException`, … with the same properties.
 */
export class AcledaError extends Error {
  override name = 'AcledaError';
}

/** The client cannot call ACLEDA as configured (no production address given). Nothing was sent. */
export class AcledaConfigError extends AcledaError {
  override name = 'AcledaConfigError';
}

/** Why a call was refused before anything was sent. */
export type AcledaInputProblem = 'currency' | 'format';

/** ACLEDA was asked in a money it is not set to take here (`currency`), or for a QR format that is not `string` or `image` (`format`). Nothing was sent. */
export class AcledaInputError extends AcledaError {
  override name = 'AcledaInputError';
  constructor(
    readonly problem: AcledaInputProblem,
    message: string,
  ) {
    super(message);
  }
}

/**
 * ACLEDA answered and said no: its code (`acledaCode`) and its `errorDetails` words (`details`) when
 * it gave them. (Not `code`: PHP's exceptions keep that name for themselves, and the twin's property
 * is the same.)
 */
export class AcledaRefusedError extends AcledaError {
  override name = 'AcledaRefusedError';
  constructor(
    readonly acledaCode: string | null,
    readonly details: string | null,
  ) {
    super(details || 'ACLEDA did not give a QR for this payment');
  }
}

/** ACLEDA did not answer, answered with an HTTP error, or with something unreadable. */
export class AcledaUnreachableError extends AcledaError {
  override name = 'AcledaUnreachableError';
  constructor(readonly operation: string) {
    super(`ACLEDA ${operation} did not answer`);
  }
}
