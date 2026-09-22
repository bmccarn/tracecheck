/** One progress update. `total` is present once the review has planned its provider requests. */
export type ProgressUpdate = { progress: number; total?: number; message: string };

/**
 * Turns the stages of a repository review into strictly increasing progress. Each collection phase and the plan count
 * one unit before the total is known. Planning fixes the total: one unit per provider request, one for the check that
 * the repository did not change, and one for completion. An update that would not advance progress is dropped, so a
 * late or repeated stage never moves progress backwards.
 */
export class ReviewProgress {
  private progress = 0;
  private total: number | undefined;
  private planned = 0;

  constructor(private readonly send: (update: ProgressUpdate) => void) {}

  /** A collection phase has started. Phases after planning are ignored. */
  phase = (message: string): void => {
    if (this.total === undefined) this.emit(this.progress + 1, message);
  };

  /** The review planned `total` requests (`completed` is 0), or one more request finished (`completed` of `total`). */
  requests = (completed: number, total: number): void => {
    if (this.total === undefined) {
      this.planned = this.progress + 1;
      this.total = this.planned + total + 2;
      this.emit(this.planned, total ? `Sending ${total} provider request${total === 1 ? '' : 's'}` : 'No provider requests needed');
      return;
    }
    this.emit(this.planned + completed, `Completed provider request ${completed} of ${total}`);
  };

  /** Every request finished; the repository is collected again to confirm it did not change. */
  checking = (): void => {
    if (this.total !== undefined) this.emit(this.total - 1, 'Checking that the repository did not change');
  };

  /** The review report is ready. */
  finished = (): void => {
    if (this.total !== undefined) this.emit(this.total, 'Review complete');
  };

  private emit(progress: number, message: string): void {
    if (progress <= this.progress) return;
    this.progress = progress;
    this.send({ progress, ...(this.total === undefined ? {} : { total: this.total }), message });
  }
}
