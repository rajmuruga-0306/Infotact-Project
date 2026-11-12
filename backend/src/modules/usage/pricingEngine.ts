import { ResourcePricingPlan, TierBreakdownItem } from '@ledgerguard/shared';

export interface CalculatedCost {
  totalCostMinor: bigint;
  breakdown: TierBreakdownItem[];
  pricingModel: 'GRADUATED' | 'VOLUME' | 'FLAT';
}

export const DEFAULT_RESOURCE_PRICING: Record<string, ResourcePricingPlan> = {
  api_calls: {
    resource: 'api_calls',
    pricingModel: 'GRADUATED',
    currency: 'USD',
    tiers: [
      { upToUnits: 1000, unitPriceMinor: 5 }, // 0 - 1,000: 5 cents (5 minor units) per unit
      { upToUnits: 10000, unitPriceMinor: 3 }, // 1,001 - 10,000: 3 cents per unit
      { upToUnits: null, unitPriceMinor: 1 }, // 10,001+: 1 cent per unit
    ],
  },
  compute_minutes: {
    resource: 'compute_minutes',
    pricingModel: 'GRADUATED',
    currency: 'USD',
    tiers: [
      { upToUnits: 500, unitPriceMinor: 10 }, // 0 - 500 mins: 10 cents per min
      { upToUnits: null, unitPriceMinor: 7 }, // 501+ mins: 7 cents per min
    ],
  },
  storage_gb: {
    resource: 'storage_gb',
    pricingModel: 'FLAT',
    currency: 'USD',
    tiers: [
      { upToUnits: null, unitPriceMinor: 20 }, // 20 cents per GB flat
    ],
  },
  bandwidth_egress: {
    resource: 'bandwidth_egress',
    pricingModel: 'GRADUATED',
    currency: 'USD',
    tiers: [
      { upToUnits: 100, unitPriceMinor: 15 }, // 0 - 100 GB: 15 cents per GB
      { upToUnits: null, unitPriceMinor: 8 }, // 101+ GB: 8 cents per GB
    ],
  },
  ai_tokens: {
    resource: 'ai_tokens',
    pricingModel: 'GRADUATED',
    currency: 'USD',
    tiers: [
      { upToUnits: 100000, unitPriceMinor: 1 }, // 1 minor unit per 100 tokens (effectively 10 per 1k)
      { upToUnits: null, unitPriceMinor: 1 }, // simplified integer scaling
    ],
  },
};

/**
 * Fallback pricing plan for unrecognized resources: 10 minor units flat per unit
 */
export function getFallbackPricingPlan(resource: string): ResourcePricingPlan {
  return {
    resource,
    pricingModel: 'FLAT',
    currency: 'USD',
    tiers: [{ upToUnits: null, unitPriceMinor: 10 }],
  };
}

export class PricingEngine {
  private customPlans = new Map<string, ResourcePricingPlan>();

  /**
   * Registers or overrides a pricing plan for a resource
   */
  registerPlan(plan: ResourcePricingPlan): void {
    this.customPlans.set(plan.resource, plan);
  }

  /**
   * Retrieves active pricing plan for a resource
   */
  getPlan(resource: string): ResourcePricingPlan {
    return this.customPlans.get(resource) || DEFAULT_RESOURCE_PRICING[resource] || getFallbackPricingPlan(resource);
  }

  /**
   * Calculates exact cost for consuming `newUnits` given `currentUnits` already consumed
   * in the current billing period.
   *
   * Guarantees signed 64-bit BigInt precision without floating-point inaccuracies.
   */
  calculateCost(resource: string, currentUnits: number, newUnits: number): CalculatedCost {
    if (newUnits <= 0) {
      return { totalCostMinor: 0n, breakdown: [], pricingModel: 'FLAT' };
    }

    const plan = this.getPlan(resource);

    if (plan.pricingModel === 'FLAT') {
      const unitPrice = BigInt(plan.tiers[0]?.unitPriceMinor ?? 10);
      const unitsCount = BigInt(Math.ceil(newUnits));
      const totalCostMinor = unitsCount * unitPrice;

      return {
        totalCostMinor,
        pricingModel: 'FLAT',
        breakdown: [
          {
            tierIndex: 0,
            unitsInTier: newUnits,
            unitPriceMinor: Number(unitPrice),
            tierCostMinor: Number(totalCostMinor),
          },
        ],
      };
    }

    if (plan.pricingModel === 'VOLUME') {
      const totalCombined = currentUnits + newUnits;
      // Find tier corresponding to totalCombined
      let selectedTier = plan.tiers[plan.tiers.length - 1]!;
      let selectedIndex = plan.tiers.length - 1;

      for (let i = 0; i < plan.tiers.length; i++) {
        const t = plan.tiers[i]!;
        if (t.upToUnits !== null && totalCombined <= t.upToUnits) {
          selectedTier = t;
          selectedIndex = i;
          break;
        }
      }

      const unitPrice = BigInt(selectedTier.unitPriceMinor);
      const unitsCount = BigInt(Math.ceil(newUnits));
      const totalCostMinor = unitsCount * unitPrice;

      return {
        totalCostMinor,
        pricingModel: 'VOLUME',
        breakdown: [
          {
            tierIndex: selectedIndex,
            unitsInTier: newUnits,
            unitPriceMinor: Number(unitPrice),
            tierCostMinor: Number(totalCostMinor),
          },
        ],
      };
    }

    // Default: GRADUATED (Block / Tiered)
    const startRange = currentUnits;
    const endRange = currentUnits + newUnits;
    let totalCostMinor = 0n;
    const breakdown: TierBreakdownItem[] = [];

    let tierStart = 0;

    for (let i = 0; i < plan.tiers.length; i++) {
      const tier = plan.tiers[i]!;
      const tierEnd = tier.upToUnits === null ? Number.POSITIVE_INFINITY : tier.upToUnits;

      // Calculate overlap between [startRange, endRange] and [tierStart, tierEnd]
      const overlapStart = Math.max(startRange, tierStart);
      const overlapEnd = Math.min(endRange, tierEnd);

      if (overlapEnd > overlapStart) {
        const unitsInTier = overlapEnd - overlapStart;
        const unitPrice = BigInt(tier.unitPriceMinor);
        const tierCost = BigInt(Math.ceil(unitsInTier)) * unitPrice;

        totalCostMinor += tierCost;
        breakdown.push({
          tierIndex: i,
          unitsInTier,
          unitPriceMinor: Number(unitPrice),
          tierCostMinor: Number(tierCost),
        });
      }

      if (endRange <= tierEnd) {
        break;
      }

      tierStart = tierEnd;
    }

    return {
      totalCostMinor,
      breakdown,
      pricingModel: 'GRADUATED',
    };
  }
}

export const defaultPricingEngine = new PricingEngine();
