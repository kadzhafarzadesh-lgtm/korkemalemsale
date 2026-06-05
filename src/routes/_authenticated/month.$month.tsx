import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { MONTHS, daysInMonth, fmt } from "@/lib/months";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/month/$month")({
  component: MonthPage,
});

type Entry = {
  id?: string;
  store_id: string;
  product_type_id: string;
  year: number;
  month: number;
  day: number;
  posted: number;
  returned: number;
  actual_balance: number | null;
  realized: number;
  opening_balance: number;
};

type Store = { id: string; name: string };
type PType = { id: string; name: string };

function MonthPage() {
  const { month } = Route.useParams();
  const m = Number(month);
  const year = new Date().getFullYear();
  const qc = useQueryClient();

  const { data: stores = [] } = useQuery<Store[]>({
    queryKey: ["stores"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stores")
        .select("id,name,sort_order")
        .eq("is_active", true)
        .order("sort_order");
      if (error) throw error;
      return (data ?? []) as Store[];
    },
  });

  const { data: ptypes = [] } = useQuery<PType[]>({
    queryKey: ["ptypes"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_types")
        .select("id,name,sort_order")
        .order("sort_order");
      if (error) throw error;
      return (data ?? []) as PType[];
    },
  });

  const { data: entries = [], isLoading } = useQuery<Entry[]>({
    queryKey: ["entries", year, m],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("daily_entries")
        .select("*")
        .eq("year", year)
        .eq("month", m)
        .limit(50000);
      if (error) throw error;
      return (data ?? []) as Entry[];
    },
  });

  const days = daysInMonth(year, m);

  const byKey = useMemo(() => {
    const x = new Map<string, Entry>();
    for (const e of entries) x.set(`${e.store_id}|${e.product_type_id}|${e.day}`, e);
    return x;
  }, [entries]);

  const rows = useMemo(() => {
    const r: { store: Store; ptype: PType }[] = [];
    for (const s of stores) for (const p of ptypes) r.push({ store: s, ptype: p });
    return r;
  }, [stores, ptypes]);

  const getDay = (storeId: string, ptypeId: string, d: number) =>
    byKey.get(`${storeId}|${ptypeId}|${d}`);

  // ФОРМУЛЫ:
  // Нач.ост. дня 1 = opening_balance.
  // Нач.ост. дня N = effective Факт. дня (N-1).
  // Факт.(автоподстановка) = последний введённый Факт. (или Нач.ост.) если в этот день не введён.
  // Реал. = Нач.ост. + Пост. − Возвр. − Факт.(effective)
  type Computed = {
    posted: number;
    returned: number;
    manual: number | null;       // введён вручную (или null)
    effective: number | null;    // факт. с учётом автозаполнения
    base: number | null;         // нач.ост. дня
    realized: number | null;
    isAuto: boolean;             // отображать ли серым
  };
  const computed = useMemo(() => {
    const map = new Map<string, Computed>();
    for (const { store, ptype } of rows) {
      const openingRaw = getDay(store.id, ptype.id, 1)?.opening_balance;
      const hasOpening = openingRaw != null && !Number.isNaN(+openingRaw);
      const opening: number | null = hasOpening ? +openingRaw! : null;
      let prevEffective: number | null = opening;
      for (let d = 1; d <= days; d++) {
        const e = getDay(store.id, ptype.id, d);
        const posted = +(e?.posted ?? 0);
        const returned = +(e?.returned ?? 0);
        const manualRaw = e?.actual_balance;
        const hasManual = manualRaw != null && !Number.isNaN(+manualRaw);
        const manual: number | null = hasManual ? +manualRaw! : null;

        const base: number | null = d === 1 ? opening : prevEffective;
        const effective: number | null = manual != null ? manual : base;
        const isAuto = manual == null && effective != null;

        const realized: number | null =
          base != null && effective != null ? base + posted - returned - effective : null;

        map.set(`${store.id}|${ptype.id}|${d}`, {
          posted, returned, manual, effective, base, realized, isAuto,
        });
        prevEffective = effective;
      }
    }
    return map;
  }, [rows, byKey, days]);

  const getComp = (s: string, p: string, d: number) => computed.get(`${s}|${p}|${d}`);

  const saveCell = async (
    storeId: string,
    ptypeId: string,
    day: number,
    field: "posted" | "returned" | "opening_balance" | "actual_balance",
    value: number | null,
  ) => {
    const existing = getDay(storeId, ptypeId, day);
    const payload: any = {
      ...(existing ?? {
        store_id: storeId,
        product_type_id: ptypeId,
        year,
        month: m,
        day,
        posted: 0,
        returned: 0,
        actual_balance: null,
        realized: 0,
        opening_balance: 0,
      }),
      [field]: value,
    };

    const { error } = await supabase
      .from("daily_entries")
      .upsert(payload, { onConflict: "store_id,product_type_id,year,month,day" });
    if (error) {
      toast.error("Ошибка сохранения", { description: error.message });
      return;
    }
    qc.invalidateQueries({ queryKey: ["entries", year, m] });
    qc.invalidateQueries({ queryKey: ["dash-entries", year] });
    qc.invalidateQueries({ queryKey: ["report-entries", year, m] });
  };

  // Totals по дням — Реал. с учётом автоподстановки.
  const dayTotals = useMemo(() => {
    const t = new Array(days + 1).fill(0).map(() => ({ posted: 0, returned: 0, realized: 0 }));
    for (const { store, ptype } of rows) {
      for (let d = 1; d <= days; d++) {
        const c = getComp(store.id, ptype.id, d);
        if (!c) continue;
        t[d].posted += c.posted;
        t[d].returned += c.returned;
        if (c.realized != null) t[d].realized += c.realized;
      }
    }
    return t;
  }, [rows, computed, days]);

  const totals = useMemo(() => {
    const t = { posted: 0, returned: 0, realized: 0 };
    for (let d = 1; d <= days; d++) {
      t.posted += dayTotals[d].posted;
      t.returned += dayTotals[d].returned;
      t.realized += dayTotals[d].realized;
    }
    return t;
  }, [dayTotals, days]);

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{MONTHS[m - 1]} {year}</h1>
        <p className="text-sm text-muted-foreground">
          Введите Пост., Возвр. и Факт.ост. Серым показан автоподставленный Факт. (последний введённый).
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <div className="border rounded-lg p-8 text-center text-muted-foreground bg-card">
          Нет активных магазинов или типов продукции. Добавьте их в Настройках.
        </div>
      ) : (
        <div className="border rounded-lg bg-card overflow-x-auto">
          <table className="text-xs num min-w-max">
            <thead className="bg-muted/60 sticky top-0 z-10">
              <tr>
                <th className="sticky left-0 bg-muted/80 px-2 py-2 border-r w-10 text-left">№</th>
                <th className="sticky left-10 bg-muted/80 px-2 py-2 border-r min-w-[260px] text-left">Магазин</th>
                <th className="sticky left-[300px] bg-muted/80 px-2 py-2 border-r w-16 text-left">Прод.</th>
                <th className="px-2 py-2 border-r text-right">Нач. ост.</th>
                {Array.from({ length: days }, (_, i) => i + 1).map((d) => (
                  <th key={d} colSpan={4} className="px-2 py-2 border-r text-center bg-primary/5">
                    День {d}
                  </th>
                ))}
              </tr>
              <tr className="text-muted-foreground">
                <th className="sticky left-0 bg-muted/80 border-r" />
                <th className="sticky left-10 bg-muted/80 border-r" />
                <th className="sticky left-[300px] bg-muted/80 border-r" />
                <th className="border-r" />
                {Array.from({ length: days }, (_, i) => i + 1).map((d) => (
                  <Fragment key={d}>
                    <th className="px-1 py-1 font-normal">Пост.</th>
                    <th className="px-1 py-1 font-normal">Возвр.</th>
                    <th className="px-1 py-1 font-normal">Факт.</th>
                    <th className="px-1 py-1 font-normal border-r">Реал.</th>
                  </Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => {
                const opening = +(getDay(row.store.id, row.ptype.id, 1)?.opening_balance ?? 0);
                return (
                  <tr key={`${row.store.id}|${row.ptype.id}`} className="border-t hover:bg-muted/30">
                    <td className="sticky left-0 bg-card px-2 py-1 border-r text-muted-foreground">{idx + 1}</td>
                    <td className="sticky left-10 bg-card px-2 py-1 border-r whitespace-nowrap">{row.store.name}</td>
                    <td className="sticky left-[300px] bg-card px-2 py-1 border-r">{row.ptype.name}</td>
                    <td className="border-r p-0">
                      <Cell
                        value={opening}
                        onSave={(v) => saveCell(row.store.id, row.ptype.id, 1, "opening_balance", v ?? 0)}
                      />
                    </td>
                    {Array.from({ length: days }, (_, i) => i + 1).map((d) => {
                      const c = getComp(row.store.id, row.ptype.id, d);
                      const isNeg = c?.realized != null && c.realized < 0;
                      return (
                        <Fragment key={d}>
                          <td className="p-0">
                            <Cell
                              value={c?.posted ?? 0}
                              onSave={(v) => saveCell(row.store.id, row.ptype.id, d, "posted", v ?? 0)}
                            />
                          </td>
                          <td className="p-0">
                            <Cell
                              value={c?.returned ?? 0}
                              onSave={(v) => saveCell(row.store.id, row.ptype.id, d, "returned", v ?? 0)}
                            />
                          </td>
                          <td className="p-0">
                            <Cell
                              value={c?.manual ?? null}
                              autoValue={c?.isAuto ? (c.effective as number) : null}
                              nullable
                              onSave={(v) => saveCell(row.store.id, row.ptype.id, d, "actual_balance", v)}
                            />
                          </td>
                          <td
                            className={
                              "px-2 py-1 text-right border-r font-medium bg-accent/5 " +
                              (isNeg ? "text-destructive" : "text-foreground")
                            }
                          >
                            {c?.realized != null ? fmt(c.realized) : "—"}
                          </td>
                        </Fragment>
                      );
                    })}
                  </tr>
                );
              })}
              <tr className="border-t bg-primary/10 font-semibold">
                <td className="sticky left-0 bg-primary/10 px-2 py-2 border-r" colSpan={3}>
                  ИТОГО
                </td>
                <td className="border-r" />
                {Array.from({ length: days }, (_, i) => i + 1).map((d) => (
                  <Fragment key={d}>
                    <td className="px-1 text-right">{fmt(dayTotals[d].posted)}</td>
                    <td className="px-1 text-right">{fmt(dayTotals[d].returned)}</td>
                    <td className="px-1 text-right">—</td>
                    <td className="px-1 text-right border-r">{fmt(dayTotals[d].realized)}</td>
                  </Fragment>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <div className="grid grid-cols-3 gap-3 max-w-md">
        <Stat label="Поступило" value={fmt(totals.posted)} />
        <Stat label="Возвращено" value={fmt(totals.returned)} />
        <Stat label="Реализовано" value={fmt(totals.realized)} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border rounded-lg px-3 py-2 bg-card">
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div className="font-semibold num">{value}</div>
    </div>
  );
}

function Cell({
  value,
  onSave,
  autoValue,
  nullable,
}: {
  value: number | null;
  onSave: (v: number | null) => void | Promise<void>;
  autoValue?: number | null;
  nullable?: boolean;
}) {
  // Если value=null и есть autoValue — показываем автоподстановку серым.
  const displayAuto = value == null && autoValue != null;
  const [v, setV] = useState(value != null ? String(value) : "");
  const [focused, setFocused] = useState(false);
  const original = useRef<number | null>(value);
  useEffect(() => {
    setV(value != null ? String(value) : "");
    original.current = value;
  }, [value]);

  const shown = focused
    ? v
    : value != null
    ? String(value)
    : displayAuto
    ? String(autoValue)
    : "";

  return (
    <input
      value={shown}
      onFocus={() => setFocused(true)}
      onChange={(e) => setV(e.target.value.replace(/[^\d.,-]/g, ""))}
      onBlur={() => {
        setFocused(false);
        const trimmed = v.trim();
        if (trimmed === "") {
          if (nullable) {
            if (original.current != null) onSave(null);
          } else {
            if (original.current !== 0) onSave(0);
          }
          return;
        }
        const n = parseFloat(trimmed.replace(",", ".")) || 0;
        if (n !== original.current) onSave(n);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      className={
        "w-14 px-1 py-1 text-right text-xs bg-transparent focus:bg-background focus:outline-none focus:ring-1 focus:ring-ring rounded " +
        (!focused && displayAuto ? "text-[#9ca3af]" : "")
      }
      inputMode="decimal"
    />
  );
}
