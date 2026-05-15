import type { EpochCacheInterface } from '@aztec/epoch-cache';
import { SlotNumber } from '@aztec/foundation/branded-types';
import { merge, pick } from '@aztec/foundation/collection';
import type { EthAddress } from '@aztec/foundation/eth-address';
import { FifoSet } from '@aztec/foundation/fifo-set';
import { type Logger, createLogger } from '@aztec/foundation/log';
import { RunningPromise } from '@aztec/foundation/running-promise';
import type { L2BlockSource } from '@aztec/stdlib/block';
import type { P2PClient, SlasherConfig } from '@aztec/stdlib/interfaces/server';
import type { BlockProposal, CheckpointProposalCore } from '@aztec/stdlib/p2p';
import { OffenseType } from '@aztec/stdlib/slashing';

import EventEmitter from 'node:events';

import { WANT_TO_SLASH_EVENT, type WantToSlashArgs, type Watcher, type WatcherEmitter } from '../watcher.js';

const BroadcastedInvalidCheckpointProposalWatcherConfigKeys = [
  'slashBroadcastedInvalidCheckpointProposalPenalty',
  'slashAttestInvalidCheckpointProposalPenalty',
] as const;

const SCAN_SLOT_LAG = 1;
const DEFAULT_SCAN_SLOT_LOOKBACK = 4;
const MAX_TRACKED_OFFENSES_PER_SLOT = 2048;

type BroadcastedInvalidCheckpointProposalWatcherConfig = Pick<
  SlasherConfig,
  (typeof BroadcastedInvalidCheckpointProposalWatcherConfigKeys)[number]
>;

type ProposalsForSlot = Awaited<ReturnType<P2PClient['getProposalsForSlot']>>;
type P2PProposalsForSlotSource = Pick<P2PClient, 'getCheckpointAttestationsForSlot' | 'getProposalsForSlot'>;

type SignedBlockProposal = {
  proposal: BlockProposal;
  signer: EthAddress;
};

/** Detects A-520 truncated-checkpoint proposal offenses and associated bad attestations from retained P2P evidence. */
export class BroadcastedInvalidCheckpointProposalWatcher
  extends (EventEmitter as new () => WatcherEmitter)
  implements Watcher
{
  private readonly log: Logger = createLogger('broadcasted-invalid-checkpoint-proposal-watcher');
  private readonly runningPromise: RunningPromise;
  private readonly emittedOffenses: FifoSet<string>;
  private readonly scanSlotLookback: number;
  private config: BroadcastedInvalidCheckpointProposalWatcherConfig;
  private lastScannedSlot: SlotNumber | undefined;

  constructor(
    private readonly p2pClient: P2PProposalsForSlotSource,
    private readonly l2BlockSource: Pick<L2BlockSource, 'getSyncedL2SlotNumber'>,
    private readonly epochCache: Pick<EpochCacheInterface, 'getSlotNow' | 'getL1Constants'>,
    config: BroadcastedInvalidCheckpointProposalWatcherConfig,
    scanSlotLookback = DEFAULT_SCAN_SLOT_LOOKBACK,
  ) {
    super();
    const constants = epochCache.getL1Constants();
    this.config = pick(config, ...BroadcastedInvalidCheckpointProposalWatcherConfigKeys);
    this.scanSlotLookback = Math.max(1, scanSlotLookback);

    this.emittedOffenses = FifoSet.withLimit<string>(MAX_TRACKED_OFFENSES_PER_SLOT * this.scanSlotLookback);

    const intervalMs = Math.max(1000, (constants.ethereumSlotDuration * 1000) / 4);
    this.runningPromise = new RunningPromise(() => this.scan(), this.log, intervalMs);
    this.log.info('BroadcastedInvalidCheckpointProposalWatcher initialized', {
      scanSlotLookback: this.scanSlotLookback,
    });
  }

  public updateConfig(config: Partial<BroadcastedInvalidCheckpointProposalWatcherConfig>): void {
    this.config = merge(this.config, pick(config, ...BroadcastedInvalidCheckpointProposalWatcherConfigKeys));
    this.log.verbose('BroadcastedInvalidCheckpointProposalWatcher config updated', this.config);
  }

  public start(): Promise<void> {
    this.runningPromise.start();
    return Promise.resolve();
  }

  public stop(): Promise<void> {
    return this.runningPromise.stop();
  }

  /**
   * Scans newly closed slots, plus a small lookback for late-arriving proposals. Anchors
   * `currentSlot` at the archiver's last synced L2 slot.
   */
  public async scan(): Promise<void> {
    if (
      this.config.slashBroadcastedInvalidCheckpointProposalPenalty <= 0n &&
      this.config.slashAttestInvalidCheckpointProposalPenalty <= 0n
    ) {
      return;
    }

    const currentSlot = (await this.l2BlockSource.getSyncedL2SlotNumber()) ?? this.epochCache.getSlotNow();
    if (currentSlot <= SlotNumber(SCAN_SLOT_LAG)) {
      return;
    }

    const newestSlotToConsider = SlotNumber(currentSlot - 1 - SCAN_SLOT_LAG);
    const oldestLookbackSlot = SlotNumber(Math.max(0, newestSlotToConsider - this.scanSlotLookback + 1));
    const oldestUnscannedSlot =
      this.lastScannedSlot === undefined ? oldestLookbackSlot : SlotNumber(this.lastScannedSlot + 1);
    const oldestSlot = SlotNumber(Math.min(oldestLookbackSlot, oldestUnscannedSlot));
    for (let slot = oldestSlot; slot <= newestSlotToConsider; slot++) {
      await this.scanSlot(SlotNumber(slot));
    }
    this.lastScannedSlot = newestSlotToConsider;
  }

  /** Scans a single slot. Public for tests. */
  public async scanSlot(slot: SlotNumber): Promise<void> {
    if (
      this.config.slashBroadcastedInvalidCheckpointProposalPenalty <= 0n &&
      this.config.slashAttestInvalidCheckpointProposalPenalty <= 0n
    ) {
      return;
    }

    const proposals = await this.p2pClient.getProposalsForSlot(slot);
    const slashArgs = (await this.getSlashArgsForProposals(slot, proposals)).filter(args =>
      this.markAsNewOffense(args),
    );
    if (slashArgs.length === 0) {
      return;
    }

    this.log.info(`Detected broadcasted invalid checkpoint proposal offense`, {
      slot,
      offenses: slashArgs.map(args => ({
        validator: args.validator.toString(),
        offenseType: args.offenseType,
        epochOrSlot: args.epochOrSlot,
      })),
    });
    this.emit(WANT_TO_SLASH_EVENT, slashArgs);
  }

  private async getSlashArgsForProposals(slot: SlotNumber, proposals: ProposalsForSlot): Promise<WantToSlashArgs[]> {
    const offenders = this.findOffenders(proposals.blockProposals, proposals.checkpointProposals);
    if (offenders.size === 0) {
      return [];
    }

    const proposerArgs =
      this.config.slashBroadcastedInvalidCheckpointProposalPenalty > 0n
        ? [...offenders.values()].map(validator => ({
            validator,
            amount: this.config.slashBroadcastedInvalidCheckpointProposalPenalty,
            offenseType: OffenseType.BROADCASTED_INVALID_CHECKPOINT_PROPOSAL,
            epochOrSlot: BigInt(slot),
          }))
        : [];

    return [...proposerArgs, ...(await this.getBadAttestationSlashArgsForProposals(slot, proposals))];
  }

  private async getBadAttestationSlashArgsForProposals(
    slot: SlotNumber,
    proposals: ProposalsForSlot,
  ): Promise<WantToSlashArgs[]> {
    if (this.config.slashAttestInvalidCheckpointProposalPenalty <= 0n || this.hasProposalEquivocation(proposals)) {
      return [];
    }

    let attestations: Awaited<ReturnType<P2PClient['getCheckpointAttestationsForSlot']>>;
    try {
      attestations = await this.p2pClient.getCheckpointAttestationsForSlot(slot);
    } catch (err) {
      this.log.warn(`Failed to fetch checkpoint attestations for invalid checkpoint proposal slot`, {
        slot,
        err,
      });
      return [];
    }

    const args: WantToSlashArgs[] = [];
    for (const attestation of attestations) {
      const attester = attestation.getSender();
      if (!attester) {
        continue;
      }

      args.push({
        validator: attester,
        amount: this.config.slashAttestInvalidCheckpointProposalPenalty,
        offenseType: OffenseType.ATTESTED_TO_INVALID_CHECKPOINT_PROPOSAL,
        epochOrSlot: BigInt(slot),
      });
    }
    return args;
  }

  private hasProposalEquivocation(proposals: ProposalsForSlot): boolean {
    const checkpointProposalHashes = new Set(proposals.checkpointProposals.map(proposal => proposal.getPayloadHash()));
    if (checkpointProposalHashes.size > 1) {
      return true;
    }

    const blockProposalHashesByPosition = new Map<string, string>();
    for (const proposal of proposals.blockProposals) {
      const positionKey = `${proposal.slotNumber}:${proposal.indexWithinCheckpoint}`;
      const payloadHash = proposal.getPayloadHash();
      const previousPayloadHash = blockProposalHashesByPosition.get(positionKey);
      if (previousPayloadHash !== undefined && previousPayloadHash !== payloadHash) {
        return true;
      }
      blockProposalHashesByPosition.set(positionKey, payloadHash);
    }

    return false;
  }

  private findOffenders(blockProposals: BlockProposal[], checkpointProposals: CheckpointProposalCore[]) {
    const blocksBySigner = this.getSignedBlocksBySigner(blockProposals);
    const offenders = new Map<string, EthAddress>();

    for (const checkpoint of checkpointProposals) {
      const checkpointSigner = checkpoint.getSender();
      if (!checkpointSigner) {
        continue;
      }

      const signerKey = checkpointSigner.toString();
      const signerBlocks = blocksBySigner.get(signerKey) ?? [];
      const terminalBlocks = signerBlocks.filter(
        ({ proposal }) => proposal.slotNumber === checkpoint.slotNumber && proposal.archive.equals(checkpoint.archive),
      );
      if (terminalBlocks.length === 0) {
        continue;
      }

      const hasTruncatedHigherBlock = terminalBlocks.some(terminalBlock =>
        signerBlocks.some(
          ({ proposal }) =>
            proposal.slotNumber === checkpoint.slotNumber &&
            proposal.indexWithinCheckpoint > terminalBlock.proposal.indexWithinCheckpoint,
        ),
      );
      if (hasTruncatedHigherBlock) {
        offenders.set(signerKey, checkpointSigner);
      }
    }

    return offenders;
  }

  private getSignedBlocksBySigner(blockProposals: BlockProposal[]): Map<string, SignedBlockProposal[]> {
    const blocksBySigner = new Map<string, SignedBlockProposal[]>();
    for (const proposal of blockProposals) {
      const signer = proposal.getSender();
      if (!signer) {
        continue;
      }
      const signerKey = signer.toString();
      const signerBlocks = blocksBySigner.get(signerKey) ?? [];
      signerBlocks.push({ proposal, signer });
      blocksBySigner.set(signerKey, signerBlocks);
    }
    return blocksBySigner;
  }

  private markAsNewOffense(args: WantToSlashArgs): boolean {
    const key = `${args.validator.toString()}-${args.offenseType}-${args.epochOrSlot}`;
    return this.emittedOffenses.addIfAbsent(key);
  }
}
