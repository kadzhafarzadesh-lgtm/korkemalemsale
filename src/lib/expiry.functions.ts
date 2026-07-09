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
