import { Schema, Document, Types, Connection } from 'mongoose';
import { TransactionType, TransactionStatus } from '@ledgerguard/shared';

export interface ITransaction extends Document {
  _id: Types.ObjectId;
  idempotencyKey: string;
  requestHash: string;
  type: TransactionType;
  amountMinor: bigint;
  currency: string;
  resource: string;
  status: TransactionStatus;
  failureReason?: string;
  signatureKeyId: string;
  createdBy: string;
  originalTransactionId?: Types.ObjectId;
  refundedAmountMinor: bigint;
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
      type: BigInt,
      required: true,
      cast: '{VALUE} is not an integer (amountMinor must be a positive integer in minor currency units)',
      validate: {
        validator: (val: bigint) => val > 0n,
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
      enum: ['PENDING', 'POSTED', 'SUCCEEDED', 'FAILED', 'ROLLED_BACK'],
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
      type: BigInt,
      required: true,
      default: 0n,
      cast: '{VALUE} is not an integer (refundedAmountMinor must be a non-negative integer)',
      validate: {
        validator: (val: bigint) => val >= 0n,
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

TransactionSchema.index({ createdAt: -1 });
TransactionSchema.index({ type: 1, status: 1 });

export function getTransactionModel(conn: Connection) {
  return conn.model<ITransaction>('Transaction', TransactionSchema);
}
