import { Schema, Document, Types, Connection } from 'mongoose';
import { UserRole } from '@ledgerguard/shared';

export interface IOrganizationMembership extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  orgId: Types.ObjectId;
  role: UserRole;
  status: 'ACTIVE' | 'SUSPENDED';
  createdAt: Date;
  updatedAt: Date;
}

export const OrganizationMembershipSchema = new Schema<IOrganizationMembership>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    orgId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: ['PLATFORM_ADMIN', 'ORG_ADMIN', 'BILLING_USER', 'VIEWER'],
      required: true,
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'SUSPENDED'],
      default: 'ACTIVE',
      index: true,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.__v;
        return ret;
      },
    },
  }
);

// Compound unique index ensuring a user can have at most one membership record per organization
OrganizationMembershipSchema.index({ userId: 1, orgId: 1 }, { unique: true });

export function getOrganizationMembershipModel(conn: Connection) {
  return conn.model<IOrganizationMembership>('OrganizationMembership', OrganizationMembershipSchema);
}
