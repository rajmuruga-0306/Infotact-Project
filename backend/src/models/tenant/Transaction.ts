import { Schema, Document, Types, Connection } from 'mongoose';
import { TransactionType, TransactionStatus } from '@ledgerguard/shared';

export interface ITransaction extends Document {
  _id: Types.ObjectId;
  idempotencyKey: string;
  requestHash: string;
  type: TransactionType;
  amountMinor: number;
  currency: string;
  resource: string;
  status: TransactionStatus;
  failureReason?: string;
  signatureKeyId: string;
  createdBy: string;
  originalTransactionId?: Types.ObjectId;
  refundedAmountMinor: number;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export const TransactionSchema = new Schema<ITransaction>(
  {
    idempotencyKey: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    requestHash: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: ['charge', 'refund'],
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
    currency: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      minlength: 3,
      maxlength: 3,
    },
    resource: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    status: {
      type: String,
      enum: ['PENDING', 'SUCCEEDED', 'FAILED', 'ROLLED_BACK'],
      required: true,
      default: 'PENDING',
      index: true,
    },
    failureReason: {
      type: String,
      trim: true,
    },
    signatureKeyId: {
      type: String,
      required: true,
      trim: true,
    },
    createdBy: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    originalTransactionId: {
      type: Schema.Types.ObjectId,
      ref: 'Transaction',
      index: true,
    },
    refundedAmountMinor: {
      type: Number,
      required: true,
      default: 0,
      validate: {
        validator: (val: number) => Number.isInteger(val) && val >= 0,
        message: 'refundedAmountMinor must be a non-negative integer',
      },
    },
    metadata: {
      type: Schema.Types.Mixed,
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

TransactionSchema.index({ createdAt: -1 });
TransactionSchema.index({ type: 1, status: 1 });

export function getTransactionModel(conn: Connection) {
  return conn.model<ITransaction>('Transaction', TransactionSchema);
}
