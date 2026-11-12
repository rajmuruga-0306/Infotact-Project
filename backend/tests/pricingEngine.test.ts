import { describe, it, expect } from 'vitest';
import { PricingEngine, DEFAULT_RESOURCE_PRICING } from '../src/modules/usage/pricingEngine.js';

describe('PricingEngine Unit Tests (Graduated, Volume, Flat Tiers)', () => {
  const engine = new PricingEngine();

  describe('1. Graduated Tiered Pricing (Block Tiers)', () => {
    // api_calls tiers:
    // Tier 0: 0 - 1,000 units: 5 minor units per unit
    // Tier 1: 1,001 - 10,000 units: 3 minor units per unit
    // Tier 2: 10,001+ units: 1 minor unit per unit

    it('calculates cost entirely within Tier 0 when usage is below first threshold', () => {
      // 500 units @ 5 = 2500 cents
      const result = engine.calculateCost('api_calls', 0, 500);
      expect(result.totalCostMinor).toBe(2500n);
      expect(result.pricingModel).toBe('GRADUATED');
      expect(result.breakdown).toHaveLength(1);
      expect(result.breakdown[0]).toEqual({
        tierIndex: 0,
        unitsInTier: 500,
        unitPriceMinor: 5,
        tierCostMinor: 2500,
      });
    });

    it('calculates cost spanning Tier 0 and Tier 1 across the 1,000 unit boundary', () => {
      // 1,500 units from 0:
      // First 1,000 @ 5 = 5,000
      // Next 500 @ 3 = 1,500
      // Total = 6,500 cents
      const result = engine.calculateCost('api_calls', 0, 1500);
      expect(result.totalCostMinor).toBe(6500n);
      expect(result.breakdown).toHaveLength(2);
      expect(result.breakdown[0]).toEqual({
        tierIndex: 0,
        unitsInTier: 1000,
        unitPriceMinor: 5,
        tierCostMinor: 5000,
      });
      expect(result.breakdown[1]).toEqual({
        tierIndex: 1,
        unitsInTier: 500,
        unitPriceMinor: 3,
        tierCostMinor: 1500,
      });
    });

    it('calculates cost spanning all 3 tiers (Tier 0, Tier 1, Tier 2)', () => {
      // 15,000 units from 0:
      // Tier 0 (0-1,000): 1,000 @ 5 = 5,000
      // Tier 1 (1,000-10,000): 9,000 @ 3 = 27,000
      // Tier 2 (10,000-15,000): 5,000 @ 1 = 5,000
      // Total = 37,000 cents
      const result = engine.calculateCost('api_calls', 0, 15000);
      expect(result.totalCostMinor).toBe(37000n);
      expect(result.breakdown).toHaveLength(3);
      expect(result.breakdown[0]!.unitsInTier).toBe(1000);
      expect(result.breakdown[1]!.unitsInTier).toBe(9000);
      expect(result.breakdown[2]!.unitsInTier).toBe(5000);
    });

    it('picks up at the correct tier based on cumulative currentUnits in the billing period', () => {
      // Already consumed 800 units this month.
      // New usage: 500 units. Total will be 1,300 units.
      // Overlap with Tier 0 (800 to 1,000): 200 units @ 5 = 1,000
      // Overlap with Tier 1 (1,000 to 1,300): 300 units @ 3 = 900
      // Total = 1,900 cents
      const result = engine.calculateCost('api_calls', 800, 500);
      expect(result.totalCostMinor).toBe(1900n);
      expect(result.breakdown).toHaveLength(2);
      expect(result.breakdown[0]).toEqual({
        tierIndex: 0,
        unitsInTier: 200,
        unitPriceMinor: 5,
        tierCostMinor: 1000,
      });
      expect(result.breakdown[1]).toEqual({
        tierIndex: 1,
        unitsInTier: 300,
        unitPriceMinor: 3,
        tierCostMinor: 900,
      });
    });

    it('calculates entirely in Tier 2 if prior usage already exceeded 10,000 units', () => {
      // Already consumed 12,000 units.
      // New usage: 2,500 units.
      // Entirely in Tier 2 @ 1 = 2,500 cents
      const result = engine.calculateCost('api_calls', 12000, 2500);
      expect(result.totalCostMinor).toBe(2500n);
      expect(result.breakdown).toHaveLength(1);
      expect(result.breakdown[0]).toEqual({
        tierIndex: 2,
        unitsInTier: 2500,
        unitPriceMinor: 1,
        tierCostMinor: 2500,
      });
    });
  });

  describe('2. Flat Rate Pricing', () => {
    // storage_gb: 20 cents per GB flat
    it('calculates flat rate regardless of prior usage', () => {
      const result = engine.calculateCost('storage_gb', 500, 100);
      expect(result.totalCostMinor).toBe(2000n); // 100 * 20 = 2000
      expect(result.pricingModel).toBe('FLAT');
    });
  });

  describe('3. Volume Tier Pricing', () => {
    it('prices all units at the tier determined by combined cumulative volume', () => {
      const volumeEngine = new PricingEngine();
      volumeEngine.registerPlan({
        resource: 'custom_volume',
        pricingModel: 'VOLUME',
        currency: 'USD',
        tiers: [
          { upToUnits: 100, unitPriceMinor: 10 },
          { upToUnits: null, unitPriceMinor: 6 },
        ],
      });

      // Combined = 50 + 80 = 130 > 100 -> all 80 units priced at 6
      const result = volumeEngine.calculateCost('custom_volume', 50, 80);
      expect(result.totalCostMinor).toBe(480n); // 80 * 6 = 480
      expect(result.pricingModel).toBe('VOLUME');
    });
  });

  describe('4. Edge Cases & Zero Units', () => {
    it('returns zero cost for 0 or negative units', () => {
      const result0 = engine.calculateCost('api_calls', 100, 0);
      expect(result0.totalCostMinor).toBe(0n);
      expect(result0.breakdown).toHaveLength(0);

      const resultNeg = engine.calculateCost('api_calls', 100, -5);
      expect(resultNeg.totalCostMinor).toBe(0n);
    });

    it('falls back to default 10 cents flat for unconfigured resources', () => {
      const result = engine.calculateCost('unknown_custom_hardware', 0, 42);
      expect(result.totalCostMinor).toBe(420n); // 42 * 10
      expect(result.pricingModel).toBe('FLAT');
    });
  });
});
