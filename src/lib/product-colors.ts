// Palette of preset colors used to mark product types across all views.
// Users pick a color from this palette in Settings; components read
// `product_types.color` and apply the returned styles for backgrounds,
// left stripes and swatches.

export type ProductColor = { hex: string; label: string };

export const PRODUCT_COLOR_PALETTE: ProductColor[] = [
  { hex: "#ef4444", label: "Красный" },
  { hex: "#f97316", label: "Оранжевый" },
  { hex: "#f59e0b", label: "Янтарный" },
  { hex: "#eab308", label: "Жёлтый" },
  { hex: "#84cc16", label: "Лаймовый" },
  { hex: "#22c55e", label: "Зелёный" },
  { hex: "#14b8a6", label: "Бирюзовый" },
  { hex: "#06b6d4", label: "Голубой" },
  { hex: "#3b82f6", label: "Синий" },
  { hex: "#6366f1", label: "Индиго" },
  { hex: "#8b5cf6", label: "Фиолетовый" },
  { hex: "#ec4899", label: "Розовый" },
];

const DEFAULT_HEX = "#94a3b8"; // slate-400 fallback

export function normalizeProductColor(input?: string | null): string {
  if (!input) return DEFAULT_HEX;
  const v = input.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  return DEFAULT_HEX;
}

// Returns inline styles for a "row fully filled" look: light tinted background
// plus a solid left-border accent stripe. Works in both light and dark modes.
export function productRowStyle(color?: string | null): React.CSSProperties {
  const hex = normalizeProductColor(color);
  return {
    backgroundColor: `${hex}1f`, // ~12% opacity tint
    borderLeft: `4px solid ${hex}`,
  };
}

export function productAccentColor(color?: string | null): string {
  return normalizeProductColor(color);
}

// A tiny circular swatch dot; useful next to labels.
export function productDotStyle(color?: string | null): React.CSSProperties {
  const hex = normalizeProductColor(color);
  return {
    backgroundColor: hex,
    boxShadow: `0 0 0 1px ${hex}55`,
  };
}
