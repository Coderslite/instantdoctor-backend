/** True when a MySQL error is a unique/primary key violation. */
export function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    ((err as { code?: string }).code === 'ER_DUP_ENTRY' ||
      (err as { cause?: { code?: string } }).cause?.code === 'ER_DUP_ENTRY')
  );
}

/** Rows affected by an UPDATE/DELETE executed through drizzle's mysql2 driver. */
export function affectedRows(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  return (header as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
}
