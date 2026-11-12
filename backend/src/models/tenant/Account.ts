import { Schema, Document, Types, Connection } from 'mongoose';
import { VIRTUAL_CLEARING_ACCOUNT } from '@ledgerguard/shared';

export { VIRTUAL_CLEARING_ACCOUNT };

export interface IAccount extends Document {
  _id: Types.ObjectId;
  accountRef: string;
  balanceMinor: number;
  creditLimitMinor: number;
  monthlyLimitMinor: number;
  currency: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const AccountSchema = new Schema<IAccount>(
  {
    accountRef: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    balanceMinor: {
      type: Number,
      required: true,
      default: 0,
      validate: {
        validator: Number.isInteger,
        message: 'balanceMinor must be an integer (minor currency units)',
      },
    },
    creditLimitMinor: {
      type: Number,
      required: true,
      default: 0,
      validate: {
        validator: (val: number) => Number.isInteger(val) && val >= 0,
        message: 'creditLimitMinor must be a non-negative integer',
      },
    },
    monthlyLimitMinor: {
      type: Number,
      required: true,
      default: 10000000, // Default 100,000 USD (in cents)
      validate: {
        validator: (val: number) => Number.isInteger(val) && val >= 0,
        message: 'monthlyLimitMinor must be a non-negative integer',
      },
    },
    currency: {
      type: String,
      required: true,
      default: 'USD',
      uppercase: true,
      trim: true,
      minlength: 3,
      maxlength: 3,
    },
  },
  {
    timestamps: true,
    versionKey: 'version',
    optimisticConcurrency: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        return ret;
      },
    },
  }
);

export function getAccountModel(conn: Connection) {
  return conn.model<IAccount>('Account', AccountSchema);
}

/**
 * Ensures the tenant database has its primary account and the virtual platform clearing account initialized.
 */
export async function initializeTenantAccounts(
  conn: Connection,
  currency: string = 'USD',
  creditLimitMinor: number = 0,
  monthlyLimitMinor: number = 10000000
): Promise<{ primary: IAccount; virtualClearing: IAccount }> {
  const Account = getAccountModel(conn);

  // 1. Primary Tenant Account
  let primary = await Account.findOne({ accountRef: 'PRIMARY' });
  if (!primary) {
    primary = await Account.create({
      accountRef: 'PRIMARY',
      balanceMinor: 0,
      creditLimitMinor,
      monthlyLimitMinor,
      currency,
    });
  }

  // 2. Virtual Clearing Account (counterpart in double-entry)
  let virtualClearing = await Account.findOne({ accountRef: VIRTUAL_CLEARING_ACCOUNT });
  if (!virtualClearing) {
    virtualClearing = await Account.create({
      accountRef: VIRTUAL_CLEARING_ACCOUNT,
      balanceMinor: 0,
      creditLimitMinor: 0,
      monthlyLimitMinor: 0,
      currency,
    });
  }

  return { primary, virtualClearing };
}
