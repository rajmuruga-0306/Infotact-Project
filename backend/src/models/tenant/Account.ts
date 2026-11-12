import { Schema, Document, Types, Connection } from 'mongoose';
import { VIRTUAL_CLEARING_ACCOUNT } from '@ledgerguard/shared';

export { VIRTUAL_CLEARING_ACCOUNT };

export interface IAccount extends Document {
  _id: Types.ObjectId;
  accountRef: string;
  balanceMinor: bigint;
  creditLimitMinor: bigint;
  monthlyLimitMinor: bigint;
  currentMonth: string;
  currentMonthSpendMinor: bigint;
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
      type: BigInt,
      required: true,
      default: 0n,
      cast: '{VALUE} is not an integer (balanceMinor must be an integer)',
    },
    creditLimitMinor: {
      type: BigInt,
      required: true,
      default: 0n,
      cast: '{VALUE} is not an integer (creditLimitMinor must be a non-negative integer)',
      validate: {
        validator: (val: bigint) => val >= 0n,
        message: 'creditLimitMinor must be a non-negative integer',
      },
    },
    monthlyLimitMinor: {
      type: BigInt,
      required: true,
      default: 10000000n, // Default 100,000 USD (in cents)
      cast: '{VALUE} is not an integer (monthlyLimitMinor must be a non-negative integer)',
      validate: {
        validator: (val: bigint) => val >= 0n,
        message: 'monthlyLimitMinor must be a non-negative integer',
      },
    },
    currentMonth: {
      type: String,
      required: true,
      default: () => new Date().toISOString().slice(0, 7),
      trim: true,
    },
    currentMonthSpendMinor: {
      type: BigInt,
      required: true,
      default: 0n,
      cast: '{VALUE} is not an integer (currentMonthSpendMinor must be a non-negative integer)',
      validate: {
        validator: (val: bigint) => val >= 0n,
        message: 'currentMonthSpendMinor must be a non-negative integer',
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

export function getAccountModel(conn: Connection) {
  return conn.model<IAccount>('Account', AccountSchema);
}

/**
 * Ensures the tenant database has its primary account and the virtual platform clearing account initialized.
 */
export async function initializeTenantAccounts(
  conn: Connection,
  currency: string = 'USD',
  creditLimitMinor: bigint | number = 0n,
  monthlyLimitMinor: bigint | number = 10000000n
): Promise<{ primary: IAccount; virtualClearing: IAccount }> {
  const Account = getAccountModel(conn);
  const currentMonth = new Date().toISOString().slice(0, 7);

  // 1. Primary Tenant Account
  let primary = await Account.findOne({ accountRef: 'PRIMARY' });
  if (!primary) {
    primary = await Account.create({
      accountRef: 'PRIMARY',
      balanceMinor: 0n,
      creditLimitMinor: BigInt(creditLimitMinor),
      monthlyLimitMinor: BigInt(monthlyLimitMinor),
      currentMonth,
      currentMonthSpendMinor: 0n,
      currency,
    });
  }

  // 2. Virtual Clearing Account (counterpart in double-entry)
  let virtualClearing = await Account.findOne({ accountRef: VIRTUAL_CLEARING_ACCOUNT });
  if (!virtualClearing) {
    virtualClearing = await Account.create({
      accountRef: VIRTUAL_CLEARING_ACCOUNT,
      balanceMinor: 0n,
      creditLimitMinor: 0n,
      monthlyLimitMinor: 0n,
      currentMonth,
      currentMonthSpendMinor: 0n,
      currency,
    });
  }

  return { primary, virtualClearing };
}
