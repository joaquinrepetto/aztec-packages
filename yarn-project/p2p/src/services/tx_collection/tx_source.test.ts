import { createLogger } from '@aztec/foundation/log';
import type { AztecNode } from '@aztec/stdlib/interfaces/client';
import { Tx, type TxValidator } from '@aztec/stdlib/tx';

import { type MockProxy, mock } from 'jest-mock-extended';

import { SharedTxValidationCache } from './shared_tx_validation_cache.js';
import { NodeRpcTxSource } from './tx_source.js';

describe('NodeRpcTxSource', () => {
  let mockClient: MockProxy<Pick<AztecNode, 'getTxsByHash'>>;
  let mockValidator: MockProxy<TxValidator>;
  let validationCache: SharedTxValidationCache;

  const makeTx = async () => {
    const tx = Tx.random();
    await tx.recomputeHash();
    return tx;
  };

  beforeEach(() => {
    mockClient = mock<Pick<AztecNode, 'getTxsByHash'>>();
    mockValidator = mock<TxValidator>();
    mockValidator.validateTx.mockResolvedValue({ result: 'valid' });
    validationCache = new SharedTxValidationCache(mockValidator, createLogger('test'));
  });

  const createSource = () => new NodeRpcTxSource(mockClient, validationCache, 'test');

  it('returns valid txs when validator accepts', async () => {
    const tx1 = await makeTx();
    const tx2 = await makeTx();
    mockClient.getTxsByHash.mockResolvedValue([tx1, tx2]);

    const result = await createSource().getTxsByHash([tx1.getTxHash(), tx2.getTxHash()]);

    expect(result.validTxs).toHaveLength(2);
    expect(result.invalidTxHashes).toHaveLength(0);
  });

  it('returns invalid tx hashes when validator rejects', async () => {
    const tx1 = await makeTx();
    const tx2 = await makeTx();
    mockClient.getTxsByHash.mockResolvedValue([tx1, tx2]);
    mockValidator.validateTx.mockResolvedValue({ result: 'invalid', reason: ['bad'] });

    const result = await createSource().getTxsByHash([tx1.getTxHash(), tx2.getTxHash()]);

    expect(result.validTxs).toHaveLength(0);
    expect(result.invalidTxHashes).toEqual([tx1.getTxHash().toString(), tx2.getTxHash().toString()]);
  });

  it('partitions txs based on validator result', async () => {
    const tx1 = await makeTx();
    const tx2 = await makeTx();
    mockClient.getTxsByHash.mockResolvedValue([tx1, tx2]);
    mockValidator.validateTx
      .mockResolvedValueOnce({ result: 'valid' })
      .mockResolvedValueOnce({ result: 'invalid', reason: ['bad'] });

    const result = await createSource().getTxsByHash([tx1.getTxHash(), tx2.getTxHash()]);

    expect(result.validTxs).toEqual([tx1]);
    expect(result.invalidTxHashes).toEqual([tx2.getTxHash().toString()]);
  });
});
