import { Schema, Document, Types, Connection } from 'mongoose';
import { LedgerDirection } from '@ledgerguard/shared';

export interface ILedgerEntry extends Document {
  _id: Types.ObjectId;
  transactionId: Types.ObjectId;
  accountRef: string;
  direction: LedgerDirection;
  amountMinor: bigint;
  balanceAfterMinor: bigint;
  createdAt: Date;
  updatedAt: Date;
}

export const LedgerEntrySchema = new Schema<ILedgerEntry>(
  {
    transactionId: {
      type: Schema.Types.ObjectId,
      ref: 'Transaction',
      required: true,
      index: true,
    },
    accountRef: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    direction: {
      type: String,
      enum: ['DEBIT', 'CREDIT'],
      required: true,
    },
    amountMinor: {
      type: BigInt,
      required: true,
      cast: '{VALUE} is not an integer (amountMinor must be a positive integer in minor currency units)',
      validate: {
        validator: (val: bigint) => val > 0n,
        message: 'amountMinor must be a positive integer in minor currency units',
      },
    },
    balanceAfterMinor: {
      type: BigInt,
      required: true,
      cast: '{VALUE} is not an integer (balanceAfterMinor must be an integer in minor currency units)',
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        for (const k of Object.keys(ret)) {
          if (typeof ret[k] === 'bigint') {
            const val = ret[k] as bigint;
            if (val >= BigInt(Number.MIN_SAFE_INTEGER) && val <= BigInt(Number.MAX_SAFE_INTEGER)) {
              ret[k] = Number(val);
            } else {
              ret[k] = val.toString();
            }
          }
        }
        return ret;
      },
    },
  }
);

LedgerEntrySchema.index({ transactionId: 1, accountRef: 1 });
LedgerEntrySchema.index({ accountRef: 1, createdAt: -1 });

export function getLedgerEntryModel(conn: Connection) {
  return conn.model<ILedgerEntry>('LedgerEntry', LedgerEntrySchema);
}
