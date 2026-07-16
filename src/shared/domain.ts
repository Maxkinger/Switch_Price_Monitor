export const priceSources = [
  "official",
  "eshop-prices",
  "ntprices",
  "deku-deals",
  "green-pipe",
] as const;

export type PriceSource = (typeof priceSources)[number];

export const initialRegionCodes = ["US", "JP", "MX", "BR", "HK"] as const;

export type RegionCode = (typeof initialRegionCodes)[number];

export const themes = ["warm-card", "calm-dark", "clean-light"] as const;

export type Theme = (typeof themes)[number];

export interface InitialSettings {
  enabledRegions: RegionCode[];
  defaultSearchRegion: RegionCode;
  createdAt: string;
}

export interface AppSettings extends InitialSettings {
  theme: Theme;
  timezone: string;
  dailyReportTime: string;
  taxState: string;
  priceHistoryRetention: "forever" | "one-year" | "two-years";
}

export interface SubscriptionInput {
  id: string;
  gameId: string;
  regionalProductIds: string[];
  createdAt: string;
}

export interface SubscriptionRecord extends SubscriptionInput {
  enabled: boolean;
}

export interface PriceSnapshot {
  regionalProductId: string;
  amountMinor: number;
  currency: string;
  cnyFen: number | null;
  source: PriceSource;
  capturedAt: string;
}

export interface HistoricalLow extends PriceSnapshot {
  regionCode: string;
}
