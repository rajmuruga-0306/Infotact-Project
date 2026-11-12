import { Schema, Document, Types, Connection } from 'mongoose';

export interface IUsageRecord extends Document {
  _id: Types.ObjectId;
  resource: string;
  units: number;
  costMinor: number;
  ts: Date;
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
      type: Number,
      required: true,
      validate: {
        validator: (val: number) => Number.isInteger(val) && val >= 0,
        message: 'costMinor must be a non-negative integer in minor currency units',
      },
    },
    ts: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
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

UsageRecordSchema.index({ resource: 1, ts: -1 });

export function getUsageRecordModel(conn: Connection) {
  return conn.model<IUsageRecord>('UsageRecord', UsageRecordSchema);
}
