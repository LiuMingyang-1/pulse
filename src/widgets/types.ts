// Widget plugin contract.
//
// Adding a card = one file in src/widgets/ exporting a WidgetDef, plus one line
// in registry.ts. The backend never needs to change: agents POST any JSON to
// /api/widgets/:id and the matching def renders it. Ids with no def fall back
// to the generic renderer (see generic.ts), so new cards show up immediately.

export type Widget = {
  id: string;
  title: string;
  data: any;
  updated_at: string;
  source: string | null;
};

export interface WidgetDef {
  id: string;
  /** Default title — the row's own title (from D1) wins when present. */
  title: string;
  /** Inline SVG markup, 22×22. */
  icon: string;
  /** Return inner HTML for the card body. `data` is null when no row exists yet. */
  render(data: any): string;
}
