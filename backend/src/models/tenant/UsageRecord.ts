import { Schema, Document, Types, Connection } from 'mongoose';

export interface IUsageRecord extends Document {
  _id: Types.ObjectId;
  resource: string;
  units: number;
  costMinor: bigint;
  ts: Date;
  idempotencyKey?: string;
  billed: boolean;
  transactionId?: Types.ObjectId;
  rateTierApplied?: unknown;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export const UsageRecordSchema = new Schema<IUsageRecord>(
  {
    resource: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    units: {
      type: Number,
      required: true,
      validate: {
        validator: (val: number) => val > 0,
        message: 'units must be greater than zero',
      },
    },
    costMinor: {
      type: BigInt,
      required: true,
      cast: '{VALUE} is not an integer (costMinor must be a non-negative integer in minor currency units)',
      validate: {
        validator: (val: bigint) => val >= 0n,
        message: 'costMinor must be a non-negative integer in minor currency units',
      },
    },
    ts: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },
    idempotencyKey: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
    },
    billed: {
      type: Boolean,
      required: true,
      default: true,
      index: true,
    },
    transactionId: {
      type: Schema.Types.ObjectId,
      ref: 'Transaction',
      index: true,
    },
    rateTierApplied: {
      type: Schema.Types.Mixed,
    },
    metadata: {
      type: Schema.Types.Mixed,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        if (ret._id) {
          ret._id = ret._id.toString();
        }
        if (ret.transactionId) {
          ret.transactionId = ret.transactionId.toString();
        }
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

UsageRecordSchema.index({ resource: 1, ts: -1 });
UsageRecordSchema.index({ resource: 1, billed: 1, ts: -1 });
UsageRecordSchema.index({ billed: 1, ts: -1 });

export function getUsageRecordModel(conn: Connection) {
  return conn.model<IUsageRecord>('UsageRecord', UsageRecordSchema);
}
