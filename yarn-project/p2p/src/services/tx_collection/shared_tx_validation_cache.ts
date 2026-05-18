import type { Logger } from '@aztec/foundation/log';
import type { Tx, TxValidationResult, TxValidator } from '@aztec/stdlib/tx';

/** Outcome of a single validation submission. Pair with the submitted tx (batch results are in input order). */
export type TxValidationOutcome =
  | { status: 'accepted' }
  | { status: 'invalid'; reason: string[] }
  | { status: 'skipped' };

/**
 * Public API for the tx validation cache shared across tx_collection sources.
 * See {@link SharedTxValidationCache} for the concrete implementation and policy.
 */
export interface ISharedTxValidationCache {
  /** Submit a tx for validation. Resolves with the outcome. */
  submit(tx: Tx): Promise<TxValidationOutcome>;
  /** Submit a batch of txs and wait for all outcomes. */
  submitBatch(txs: Tx[]): Promise<TxValidationOutcome[]>;
}

type PendingEntry = {
  tx: Tx;
  resolve: (outcome: TxValidationOutcome) => void;
};

/**
 * Caches tx validation across all tx_collection sources. Concurrent submissions for the
 * same tx hash are serialized through a per-hash drain loop; submissions for different
 * hashes proceed in parallel.
 *
 * Caching policy:
 * - Valid outcomes are remembered for the lifetime of the cache. Subsequent submissions
 *   for an already-validated hash return `skipped` without re-running the validator.
 * - Invalid outcomes are NEVER cached. A tx's claimed `txHash` is only trustworthy after
 *   validation (only `DataTxValidator` enforces `claim == content`); caching invalid would
 *   let a peer DoS legitimate copies of a hash by pre-submitting a forgery.
 * - First-invalid does not poison the per-hash queue: the next entry is validated normally
 *   and may pass, in which case the remaining entries are drained as `skipped`.
 */
export class SharedTxValidationCache implements ISharedTxValidationCache {
  private readonly validatedHashes = new Set<string>();
  private readonly pendingByHash = new Map<string, PendingEntry[]>();
  private readonly activeHashes = new Set<string>();

  constructor(
    private readonly validator: TxValidator<Tx>,
    private readonly logger: Logger,
  ) {}

  /** Submit a tx for validation. */
  public submit(tx: Tx): Promise<TxValidationOutcome> {
    const hash = tx.txHash.toString();

    if (this.validatedHashes.has(hash)) {
      return Promise.resolve({ status: 'skipped' });
    }

    let resolve!: (outcome: TxValidationOutcome) => void;
    const promise = new Promise<TxValidationOutcome>(r => {
      resolve = r;
    });
    const entry: PendingEntry = { tx, resolve };

    const queue = this.pendingByHash.get(hash);
    if (queue) {
      queue.push(entry);
    } else {
      this.pendingByHash.set(hash, [entry]);
    }

    if (!this.activeHashes.has(hash)) {
      this.activeHashes.add(hash);
      void this.processHash(hash).catch(err => {
        this.logger.error(`Validation drain loop for tx ${hash} crashed`, err);
      });
    }

    return promise;
  }

  /** Submit a batch of txs and wait for all outcomes. */
  public submitBatch(txs: Tx[]): Promise<TxValidationOutcome[]> {
    return Promise.all(txs.map(tx => this.submit(tx)));
  }

  private async processHash(hash: string): Promise<void> {
    try {
      while (true) {
        const queue = this.pendingByHash.get(hash);
        if (!queue || queue.length === 0) {
          return;
        }

        const entry = queue.shift()!;

        if (this.validatedHashes.has(hash)) {
          entry.resolve({ status: 'skipped' });
          continue;
        }

        let result: TxValidationResult;
        try {
          result = await this.validator.validateTx(entry.tx);
        } catch (err) {
          this.logger.warn(`Validator threw for tx ${hash}`, { err });
          result = { result: 'invalid', reason: [err instanceof Error ? err.message : String(err)] };
        }

        if (result.result === 'valid') {
          this.validatedHashes.add(hash);
          entry.resolve({ status: 'accepted' });
          // Any txs still queued for this hash are either (1) correct and identical to the canonical
          // valid copy or (2) forgeries; either way we don't need to re-validate them.
          // NOTE: Fields not included in the hash could be different.
          // NOTE: This skips penalizing the peer for the forged TX if that is the case. This is the
          // downside of doing caching this way.
          for (const remaining of queue) {
            remaining.resolve({ status: 'skipped' });
          }
          queue.length = 0;
          return;
        }

        entry.resolve({ status: 'invalid', reason: result.reason });
      }
    } finally {
      this.activeHashes.delete(hash);
      this.pendingByHash.delete(hash);
    }
  }
}
