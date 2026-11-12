import { Schema, Document, Types, Connection } from 'mongoose';
import { LedgerDirection } from '@ledgerguard/shared';

export interface ILedgerEntry extends Document {
  _id: Types.ObjectId;
  transactionId: Types.ObjectId;
  accountRef: string;
  direction: LedgerDirection;
  amountMinor: number;
  balanceAfterMinor: number;
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
      type: Number,
      required: true,
      validate: {
        validator: (val: number) => Number.isInteger(val) && val > 0,
        message: 'amountMinor must be a positive integer in minor currency units',
      },
    },
    balanceAfterMinor: {
      type: Number,
      required: true,
      validate: {
        validator: Number.isInteger,
        message: 'balanceAfterMinor must be an integer in minor currency units',
      },
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
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
