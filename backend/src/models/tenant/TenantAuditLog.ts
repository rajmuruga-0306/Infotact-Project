import { Schema, Document, Types, Connection } from 'mongoose';

export interface ITenantAuditLog extends Document {
  _id: Types.ObjectId;
  ts: Date;
  actorId: string;
  action: string;
  requestId: string;
  ip: string;
  outcome: 'SUCCESS' | 'FAILURE' | 'BLOCKED';
  details?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export const TenantAuditLogSchema = new Schema<ITenantAuditLog>(
  {
    ts: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },
    actorId: {
      type: String,
      required: true,
      index: true,
    },
    action: {
      type: String,
      required: true,
      index: true,
    },
    requestId: {
      type: String,
      required: true,
      trim: true,
    },
    ip: {
      type: String,
      required: true,
      trim: true,
    },
    outcome: {
      type: String,
      enum: ['SUCCESS', 'FAILURE', 'BLOCKED'],
      required: true,
    },
    details: {
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

TenantAuditLogSchema.index({ action: 1, ts: -1 });

export function getTenantAuditLogModel(conn: Connection) {
  return conn.model<ITenantAuditLog>('TenantAuditLog', TenantAuditLogSchema);
}
