import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export type ExpiryBatch = {
  store_id: string;
  store_name: string;
  product_id: string;
  product_name: string;
  shelf_life_days: number;
  price: number | null;
  received_date: string; // YYYY-MM-DD ("opening" for synthetic)
  is_synthetic: boolean;
  qty: number;
  expires_at: string;
  days_left: number;
};

export type ExpirySummary = {
  today: string;
  batches: ExpiryBatch[];
  totals: { expired: number; critical: number; warning: number; ok: number };
  loss_amount: number; // ₸ по просрочке (сумма qty*price для days_left<0, если price задана)
};

function toISO(y: number, m: number, d: number) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function addDays(iso: string, days: number) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
function diffDays(a: string, b: string) {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const aT = Date.UTC(ay, am - 1, ad);
  const bT = Date.UTC(by, bm - 1, bd);
  return Math.round((aT - bT) / 86400000);
}

export const getExpiryReport = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ExpirySummary> => {
    const { supabase } = context;

    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Aqtau" }).format(new Date());

    const [storesRes, ptypesRes, entriesRes] = await Promise.all([
      supabase.from("stores").select("id,name,is_active,sort_order").order("sort_order").order("name"),
      supabase.from("product_types").select("id,name,shelf_life_days,sort_order,price").order("sort_order").order("name"),
      supabase
        .from("daily_entries")
        .select("store_id,product_type_id,year,month,day,opening_balance,posted,returned,written_off,actual_balance")
        .order("year").order("month").order("day"),
    ]);

    const stores = (storesRes.data ?? []).filter((s: any) => s.is_active);
    const ptypes = (ptypesRes.data ?? []).filter((p: any) => (p.shelf_life_days ?? 0) > 0);
    const entries = entriesRes.data ?? [];

    const storeById = new Map(stores.map((s: any) => [s.id, s]));
    const ptypeById = new Map(ptypes.map((p: any) => [p.id, p]));

    // group by (store, product)
    type Key = string;
    const grouped = new Map<Key, any[]>();
    for (const e of entries as any[]) {
      if (!storeById.has(e.store_id) || !ptypeById.has(e.product_type_id)) continue;
      const k = `${e.store_id}|${e.product_type_id}`;
      const arr = grouped.get(k) ?? [];
      arr.push(e);
      grouped.set(k, arr);
    }

    const batches: ExpiryBatch[] = [];

    for (const [key, list] of grouped) {
      const [storeId, productId] = key.split("|");
      const store = storeById.get(storeId)!;
      const product = ptypeById.get(productId)!;
      const shelf = product.shelf_life_days as number;

      // chronological
      list.sort(
        (a, b) => a.year - b.year || a.month - b.month || a.day - b.day,
      );

      // FIFO queue
      const queue: { date: string; qty: number; synthetic: boolean }[] = [];
      let initialized = false;

      for (const row of list) {
        const date = toISO(row.year, row.month, row.day);
        if (date > today) break;

        // Treat opening_balance of the very first day we see as a synthetic batch.
        if (!initialized) {
          const opening = Number(row.opening_balance) || 0;
          if (opening > 0) queue.push({ date, qty: opening, synthetic: true });
          initialized = true;
        }

        // posted -> new batch
        const posted = Number(row.posted) || 0;
        if (posted > 0) queue.push({ date, qty: posted, synthetic: false });

        // consumption = realized + returned (both physically leave stock from oldest first)
        const returned = Number(row.returned) || 0;
        const writtenOff = Number(row.written_off) || 0;
        let realized = 0;
        if (row.actual_balance !== null && row.actual_balance !== undefined) {
          const total = queue.reduce((s, b) => s + b.qty, 0);
          realized = Math.max(0, total - returned - writtenOff - Number(row.actual_balance));
        }
        let consume = realized + returned + writtenOff;
        while (consume > 0 && queue.length) {
          const head = queue[0];
          if (head.qty <= consume) {
            consume -= head.qty;
            queue.shift();
          } else {
            head.qty -= consume;
            consume = 0;
          }
        }
      }

      for (const b of queue) {
        if (b.qty <= 0) continue;
        const expires_at = addDays(b.date, shelf);
        const days_left = diffDays(expires_at, today);
        batches.push({
          store_id: storeId,
          store_name: store.name,
          product_id: productId,
          product_name: product.name,
          shelf_life_days: shelf,
          price: product.price != null ? Number(product.price) : null,
          received_date: b.date,
          is_synthetic: b.synthetic,
          qty: Math.round(b.qty * 100) / 100,
          expires_at,
          days_left,
        });
      }
    }

    batches.sort((a, b) => a.days_left - b.days_left);

    const totals = { expired: 0, critical: 0, warning: 0, ok: 0 };
    let loss_amount = 0;
    for (const b of batches) {
      if (b.days_left < 0) {
        totals.expired++;
        if (b.price != null) loss_amount += b.qty * b.price;
      }
      else if (b.days_left < 3) totals.critical++;
      else if (b.days_left < 5) totals.warning++;
      else totals.ok++;
    }

    return { today, batches, totals, loss_amount: Math.round(loss_amount * 100) / 100 };
  });

export const writeOffBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { store_id: string; product_type_id: string; qty: number }) =>
    z.object({
      store_id: z.string().uuid(),
      product_type_id: z.string().uuid(),
      qty: z.number().positive(),
    }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Aqtau" }).format(new Date());
    const [y, mo, d] = today.split("-").map(Number);
    // Read current row (if any) to add on top of existing written_off
    const { data: existing } = await supabase
      .from("daily_entries")
      .select("written_off")
      .eq("store_id", data.store_id)
      .eq("product_type_id", data.product_type_id)
      .eq("year", y).eq("month", mo).eq("day", d)
      .maybeSingle();
    const current = Number((existing as any)?.written_off ?? 0);
    const payload = {
      store_id: data.store_id,
      product_type_id: data.product_type_id,
      year: y, month: mo, day: d,
      written_off: current + data.qty,
    };
    const { error } = await supabase
      .from("daily_entries")
      .upsert(payload as any, { onConflict: "store_id,product_type_id,year,month,day" });
    if (error) throw error;
    return { ok: true, date: today };
  });

export type StockRow = {
  store_id: string;
  store_name: string;
  counterparty_id: string | null;
  product_id: string;
  product_name: string;
  stock: number;
  days_since_revision: number | null;
  next_expiry_date: string | null;
  days_to_expiry: number | null;
  low: boolean;
  overstock: boolean;
};

export const getStockReport = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ today: string; rows: StockRow[] }> => {
    const summary = await (getExpiryReport as any)({});
    const { supabase } = context;
    const today = summary.today as string;

    // fetch stores/ptypes for full grid (including items without batches)
    const [storesRes, ptypesRes, entriesRes] = await Promise.all([
      supabase.from("stores").select("id,name,counterparty_id,is_active,sort_order").order("sort_order").order("name"),
      supabase.from("product_types").select("id,name,sort_order").order("sort_order").order("name"),
      supabase.from("daily_entries")
        .select("store_id,product_type_id,year,month,day,actual_balance")
        .not("actual_balance", "is", null)
        .order("year").order("month").order("day"),
    ]);
    const stores = (storesRes.data ?? []).filter((s: any) => s.is_active);
    const ptypes = (ptypesRes.data ?? []);
    const entries = (entriesRes.data ?? []) as any[];

    // last revision date per (store, product)
    const lastRev = new Map<string, string>();
    for (const e of entries) {
      const k = `${e.store_id}|${e.product_type_id}`;
      const d = `${e.year}-${String(e.month).padStart(2,'0')}-${String(e.day).padStart(2,'0')}`;
      const prev = lastRev.get(k);
      if (!prev || d > prev) lastRev.set(k, d);
    }

    // aggregate batches per (store, product)
    type Agg = { stock: number; next?: string; nextDays?: number };
    const agg = new Map<string, Agg>();
    for (const b of summary.batches as any[]) {
      const k = `${b.store_id}|${b.product_id}`;
      const a = agg.get(k) ?? { stock: 0 };
      a.stock += b.qty;
      if (a.next === undefined || b.days_left < (a.nextDays ?? Infinity)) {
        a.next = b.expires_at;
        a.nextDays = b.days_left;
      }
      agg.set(k, a);
    }

    const rows: StockRow[] = [];
    const diffDays = (a: string, b: string) => {
      const [ay, am, ad] = a.split("-").map(Number);
      const [by, bm, bd] = b.split("-").map(Number);
      return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86400000);
    };

    for (const s of stores as any[]) {
      for (const p of ptypes as any[]) {
        const k = `${s.id}|${p.id}`;
        const a = agg.get(k);
        const stock = a ? Math.round(a.stock * 100) / 100 : 0;
        const rev = lastRev.get(k) ?? null;
        rows.push({
          store_id: s.id,
          store_name: s.name,
          counterparty_id: s.counterparty_id ?? null,
          product_id: p.id,
          product_name: p.name,
          stock,
          days_since_revision: rev ? diffDays(today, rev) : null,
          next_expiry_date: a?.next ?? null,
          days_to_expiry: a?.nextDays ?? null,
          low: stock > 0 && stock < 5,
          overstock: stock > 100,
        });
      }
    }

    rows.sort((a, b) => (a.days_to_expiry ?? 9999) - (b.days_to_expiry ?? 9999));
    return { today, rows };
  });
