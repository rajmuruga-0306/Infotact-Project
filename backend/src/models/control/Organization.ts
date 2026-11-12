import { Schema, Document, Types, Connection } from 'mongoose';

export interface IOrganization extends Document {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  dbName: string;
  dbUri?: string;
  status: 'ACTIVE' | 'SUSPENDED';
  publicKeyPem: string;
  keyId: string;
  keyStatus: 'ACTIVE' | 'ROTATED';
  createdAt: Date;
  updatedAt: Date;
}

export const OrganizationSchema = new Schema<IOrganization>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 100,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      minlength: 2,
      maxlength: 50,
      match: /^[a-z0-9-]+$/,
    },
    dbName: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    dbUri: {
      type: String,
      required: false,
      // Optional dedicated cluster override; design to be encrypted at rest
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'SUSPENDED'],
      default: 'ACTIVE',
      index: true,
    },
    publicKeyPem: {
      type: String,
      required: true,
    },
    keyId: {
      type: String,
      required: true,
      index: true,
    },
    keyStatus: {
      type: String,
      enum: ['ACTIVE', 'ROTATED'],
      default: 'ACTIVE',
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        // Strip sensitive database URI and internal versioning
        delete ret.dbUri;
        delete ret.__v;
        return ret;
      },
    },
  }
);

export function getOrganizationModel(conn: Connection) {
  return conn.model<IOrganization>('Organization', OrganizationSchema);
}
