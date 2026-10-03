export class MigrationReport {
  readonly startedAt = new Date();
  readonly tables: Record<string, { source: number; written: number; skipped: number }> = {};
  readonly skipped: Array<{ entity: string; id: string; reason: string }> = [];
  readonly warnings: Array<{ entity: string; id: string; message: string }> = [];

  source(table: string, n: number) {
    this.entry(table).source += n;
  }

  written(table: string, n: number) {
    this.entry(table).written += n;
  }

  skip(table: string, id: string, reason: string) {
    this.entry(table).skipped++;
    this.skipped.push({ entity: table, id, reason });
  }

  warn(entity: string, id: string, message: string) {
    this.warnings.push({ entity, id, message });
  }

  private entry(table: string) {
    return (this.tables[table] ??= { source: 0, written: 0, skipped: 0 });
  }

  toJSON() {
    return {
      startedAt: this.startedAt,
      finishedAt: new Date(),
      tables: this.tables,
      skippedCount: this.skipped.length,
      warningCount: this.warnings.length,
      skipped: this.skipped,
      warnings: this.warnings,
    };
  }
}
