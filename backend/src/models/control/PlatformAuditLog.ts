import { Schema, Document, Types, Connection } from 'mongoose';

export interface IPlatformAuditLog extends Document {
  _id: Types.ObjectId;
  ts: Date;
  actorId?: string;
  orgId?: string;
  action: string;
  ip: string;
  requestId: string;
  outcome: 'SUCCESS' | 'FAILURE' | 'BLOCKED';
  details?: Record<string, unknown>;
}

export const PlatformAuditLogSchema = new Schema<IPlatformAuditLog>(
  {
    ts: {
      type: Date,
      default: Date.now,
      index: true,
    },
    actorId: {
      type: String,
      required: false,
      index: true,
    },
    orgId: {
      type: String,
      required: false,
      index: true,
    },
    action: {
      type: String,
      required: true,
      index: true,
    },
    ip: {
      type: String,
      required: true,
    },
    requestId: {
      type: String,
      required: true,
      index: true,
    },
    outcome: {
      type: String,
      enum: ['SUCCESS', 'FAILURE', 'BLOCKED'],
      required: true,
    },
    details: {
      type: Schema.Types.Mixed,
      required: false,
    },
  },
  {
    timestamps: false,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.__v;
        return ret;
      },
    },
  }
);

PlatformAuditLogSchema.index({ ts: -1 });
PlatformAuditLogSchema.index({ action: 1, ts: -1 });

export function getPlatformAuditLogModel(conn: Connection) {
  return conn.model<IPlatformAuditLog>('PlatformAuditLog', PlatformAuditLogSchema);
}
