import { Data, Quantity } from "@ganache/utils";
import {
  GanacheRawBlockTransactionMetaData,
  GanacheRawExtraTx,
  TransactionFactory,
  TypedDatabaseTransaction,
  TypedTransaction
} from "@ganache/ethereum-transaction";
import type Common from "@ethereumjs/common";
import { encode, decode } from "@ganache/rlp";
import { BlockHeader, makeHeader } from "./runtime-block";
import { keccak } from "@ganache/utils";
import { EthereumRawBlockHeader, GanacheRawBlock } from "./serialize";
import { BlockParams } from "./block-params";

export type BaseFeeHeader = BlockHeader &
  Required<Pick<BlockHeader, "baseFeePerGas">>;

export class Block {
  /**
   *  Base fee per gas for blocks without a parent containing a base fee per gas.
   */
  static readonly INITIAL_BASE_FEE_PER_GAS =
    BlockParams.INITIAL_BASE_FEE_PER_GAS;

  protected _size: number;
  protected _raw: EthereumRawBlockHeader;
  protected _common: Common;
  protected _rawTransactions: TypedDatabaseTransaction[];
  protected _rawTransactionMetaData: GanacheRawBlockTransactionMetaData[];

  public header: BlockHeader;

  constructor(serialized: Buffer, common: Common) {
    this._common = common;
    if (serialized) {
      const deserialized = decode<GanacheRawBlock>(serialized);
      this._raw = deserialized[0];
      this._rawTransactions = deserialized[1] || [];
      // TODO: support actual uncle data (needed for forking!)
      // Issue: https://github.com/trufflesuite/ganache/issues/786
      // const uncles = deserialized[2];
      const totalDifficulty = deserialized[3];
      this.header = makeHeader(this._raw, totalDifficulty);
      this._rawTransactionMetaData = deserialized[4] || [];
      this._size = Quantity.from(deserialized[5]).toNumber();
    }
  }

  private _hash: Data;
  hash() {
    return (
      this._hash || (this._hash = Data.from(keccak(encode(this._raw)), 32))
    );
  }

  getTransactions() {
    const common = this._common;
    return this._rawTransactions.map((raw, index) => {
      const [from, hash] = this._rawTransactionMetaData[index];
      const extra: GanacheRawExtraTx = [
        from,
        hash,
        this.hash().toBuffer(),
        this.header.number.toBuffer(),
        Quantity.from(index).toBuffer()
      ];
      return TransactionFactory.fromDatabaseTx(raw, common, extra);
    });
  }

  toJSON(includeFullTransactions = false) {
    const hash = this.hash();
    const txFn = this.getTxFn(includeFullTransactions);
    const hashBuffer = hash.toBuffer();
    const number = this.header.number.toBuffer();
    const common = this._common;
    const jsonTxs = this._rawTransactions.map((raw, index) => {
      const [from, hash] = this._rawTransactionMetaData[index];
      const extra: GanacheRawExtraTx = [
        from,
        hash,
        hashBuffer,
        number,
        Quantity.from(index).toBuffer()
      ];
      const tx = TransactionFactory.fromDatabaseTx(raw, common, extra);
      return txFn(tx);
    });

    return {
      hash,
      ...this.header,
      size: Quantity.from(this._size),
      transactions: jsonTxs,
      uncles: [] as string[] // this.value.uncleHeaders.map(function(uncleHash) {return to.hex(uncleHash)})
    };
  }

  getTxFn(
    include = false
  ): (tx: TypedTransaction) => ReturnType<TypedTransaction["toJSON"]> | Data {
    if (include) {
      return (tx: TypedTransaction) => tx.toJSON(this._common);
    } else {
      return (tx: TypedTransaction) => tx.hash;
    }
  }

  static fromParts(
    rawHeader: EthereumRawBlockHeader,
    txs: TypedDatabaseTransaction[],
    totalDifficulty: Buffer,
    extraTxs: GanacheRawBlockTransactionMetaData[],
    size: number,
    common: Common
  ): Block {
    const block = new Block(null, common);
    block._raw = rawHeader;
    block._rawTransactions = txs;
    block.header = makeHeader(rawHeader, totalDifficulty);
    block._rawTransactionMetaData = extraTxs;
    block._size = size;
    return block;
  }

  static calcNextBaseFeeBigInt(parentHeader: BaseFeeHeader) {
    let nextBaseFee: bigint;

    const header = parentHeader;
    const parentGasTarget = header.gasLimit.toBigInt() / BlockParams.ELASTICITY;
    const parentGasUsed = header.gasUsed.toBigInt();
    const baseFeePerGas = header.baseFeePerGas
      ? header.baseFeePerGas.toBigInt()
      : BlockParams.INITIAL_BASE_FEE_PER_GAS;

    if (parentGasTarget === parentGasUsed) {
      // If the parent gasUsed is the same as the target, the baseFee remains unchanged.
      nextBaseFee = baseFeePerGas;
    } else if (parentGasUsed > parentGasTarget) {
      // If the parent block used more gas than its target, the baseFee should increase.
      const gasUsedDelta = parentGasUsed - parentGasTarget;
      const adjustedFeeDelta =
        (baseFeePerGas * gasUsedDelta) /
        parentGasTarget /
        BlockParams.BASE_FEE_MAX_CHANGE_DENOMINATOR;
      if (adjustedFeeDelta > 1n) {
        nextBaseFee = baseFeePerGas + adjustedFeeDelta;
      } else {
        nextBaseFee = baseFeePerGas + 1n;
      }
    } else {
      // Otherwise if the parent block used less gas than its target, the baseFee should decrease.
      const gasUsedDelta = parentGasTarget - parentGasUsed;
      const adjustedFeeDelta =
        (baseFeePerGas * gasUsedDelta) /
        parentGasTarget /
        BlockParams.BASE_FEE_MAX_CHANGE_DENOMINATOR;
      nextBaseFee = baseFeePerGas - adjustedFeeDelta;
    }

    return nextBaseFee;
  }

  static calcNBlocksMaxBaseFee(blocks: number, parentHeader: BaseFeeHeader) {
    const { BASE_FEE_MAX_CHANGE_DENOMINATOR } = BlockParams;

    let maxPossibleBaseFee = this.calcNextBaseFeeBigInt(parentHeader);

    // we must calculate each future block's max base fee individually because
    // each block's base fee must be appropriately "floored" (Math.floor) before
    // the following block's base fee is calculated. If we don't do this we'll
    // end up with compounding rounding errors.
    // FYI: the more performant, but rounding error-prone, way is:
    // return lastMaxBlockBaseFee + (lastMaxBlockBaseFee * ((BASE_FEE_MAX_CHANGE_DENOMINATOR-1)**(blocks-1)) / ((BASE_FEE_MAX_CHANGE_DENOMINATOR)**(blocks-1)))
    while (--blocks) {
      maxPossibleBaseFee +=
        maxPossibleBaseFee / BASE_FEE_MAX_CHANGE_DENOMINATOR;
    }
    return maxPossibleBaseFee;
  }

  static calcNextBaseFee(parentBlock: Block) {
    const header = parentBlock.header;
    if (header.baseFeePerGas === undefined) {
      return undefined;
    } else {
      return this.calcNextBaseFeeBigInt(<BaseFeeHeader>header);
    }
  }
}
