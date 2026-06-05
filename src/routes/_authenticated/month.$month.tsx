import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, useEffect, useRef } from "react";
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
  actual_balance: number;
  realized: number;
  opening_balance: number;
};

function MonthPage() {
  const { month } = Route.useParams();
  const m = Number(month);
  const year = new Date().getFullYear();
  const qc = useQueryClient();

  const { data: stores = [] } = useQuery({
    queryKey: ["stores"],
    queryFn: async () => (await supabase.from("stores").select("*").eq("is_active", true).order("sort_order")).data ?? [],
  });
  const { data: ptypes = [] } = useQuery({
    queryKey: ["ptypes"],
    queryFn: async () => (await supabase.from("product_types").select("*").order("sort_order")).data ?? [],
  });

  const { data: entries = [], isLoading } = useQuery({
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
  // build map key store_id|product_type_id|day -> entry
  const byKey = useMemo(() => {
    const x = new Map<string, Entry>();
    for (const e of entries) x.set(`${e.store_id}|${e.product_type_id}|${e.day}`, e);
    return x;
  }, [entries]);

  const rows = useMemo(() => {
    const result: { store: any; ptype: any }[] = [];
    for (const s of stores) for (const p of ptypes) result.push({ store: s, ptype: p });
    return result;
  }, [stores, ptypes]);

  const getDay = (storeId: string, ptypeId: string, d: number) =>
    byKey.get(`${storeId}|${ptypeId}|${d}`);

  const saveCell = async (
    storeId: string, ptypeId: string, day: number, field: "posted" | "returned" | "opening_balance", value: number,
  ) => {
    const existing = getDay(storeId, ptypeId, day);
    // recompute actual_balance and realized
    const prev = day > 1 ? getDay(storeId, ptypeId, day - 1) : null;
    const opening = field === "opening_balance" ? value : existing?.opening_balance ?? 0;
    const posted = field === "posted" ? value : existing?.posted ?? 0;
    const returned = field === "returned" ? value : existing?.returned ?? 0;
    const prevActual = prev ? +prev.actual_balance : 0;
    const baseOpening = day === 1 ? opening : prevActual;
    const actual_balance = baseOpening + posted - returned;
    const realized = day === 1 ? 0 : Math.max(0, prevActual - actual_balance);

    const payload: Entry = {
      ...(existing ?? { store_id: storeId, product_type_id: ptypeId, year, month: m, day, posted: 0, returned: 0, actual_balance: 0, realized: 0, opening_balance: 0 }),
      posted, returned, opening_balance: opening, actual_balance, realized,
    };

    const { data, error } = await supabase
      .from("daily_entries")
      .upsert(payload, { onConflict: "store_id,product_type_id,year,month,day" })
      .select()
      .single();
    if (error) { toast.error("Ошибка сохранения", { description: error.message }); return; }

    // recompute downstream days for this store/ptype
    let prevAct = +(data as Entry).actual_balance;
    for (let dd = day + 1; dd <= days; dd++) {
      const e = getDay(storeId, ptypeId, dd);
      if (!e) continue;
      const newActual = prevAct + (+e.posted) - (+e.returned);
      const newReal = Math.max(0, prevAct - newActual);
      if (newActual !== +e.actual_balance || newReal !== +e.realized) {
        await supabase.from("daily_entries").update({ actual_balance: newActual, realized: newReal }).eq("id", e.id!);
      }
      prevAct = newActual;
    }
    qc.invalidateQueries({ queryKey: ["entries", year, m] });
  };

  const totals = useMemo(() => {
    const t = { posted: 0, returned: 0, realized: 0 };
    for (const e of entries) { t.posted += +e.posted; t.returned += +e.returned; t.realized += +e.realized; }
    return t;
  }, [entries]);

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{MONTHS[m - 1]} {year}</h1>
        <p className="text-sm text-muted-foreground">Кликните по ячейке, чтобы изменить значение. Сохраняется автоматически.</p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="border rounded-lg bg-card overflow-x-auto">
          <table className="text-xs num min-w-max">
            <thead className="bg-muted/60 sticky top-0 z-10">
              <tr>
                <th className="sticky left-0 bg-muted/80 px-2 py-2 border-r w-10 text-left">№</th>
                <th className="sticky left-10 bg-muted/80 px-2 py-2 border-r min-w-[200px] text-left">Магазин</th>
                <th className="sticky left-[260px] bg-muted/80 px-2 py-2 border-r w-16 text-left">Прод.</th>
                <th className="px-2 py-2 border-r text-right">Нач. ост.</th>
                {Array.from({ length: days }, (_, i) => i + 1).map(d => (
                  <th key={d} colSpan={4} className="px-2 py-2 border-r text-center bg-primary/5">День {d}</th>
                ))}
              </tr>
              <tr className="text-muted-foreground">
                <th className="sticky left-0 bg-muted/80 border-r"></th>
                <th className="sticky left-10 bg-muted/80 border-r"></th>
                <th className="sticky left-[260px] bg-muted/80 border-r"></th>
                <th className="border-r"></th>
                {Array.from({ length: days }, (_, i) => i + 1).map(d => (
                  <>
                    <th key={`p${d}`} className="px-1 py-1 font-normal">Пост.</th>
                    <th key={`r${d}`} className="px-1 py-1 font-normal">Возвр.</th>
                    <th key={`a${d}`} className="px-1 py-1 font-normal">Факт.</th>
                    <th key={`s${d}`} className="px-1 py-1 font-normal border-r">Реал.</th>
                  </>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => {
                const opening = getDay(row.store.id, row.ptype.id, 1)?.opening_balance ?? 0;
                return (
                  <tr key={`${row.store.id}|${row.ptype.id}`} className="border-t hover:bg-muted/30">
                    <td className="sticky left-0 bg-card px-2 py-1 border-r text-muted-foreground">{idx + 1}</td>
                    <td className="sticky left-10 bg-card px-2 py-1 border-r whitespace-nowrap">{row.store.name}</td>
                    <td className="sticky left-[260px] bg-card px-2 py-1 border-r">{row.ptype.name}</td>
                    <td className="border-r p-0">
                      <Cell value={opening} onSave={(v) => saveCell(row.store.id, row.ptype.id, 1, "opening_balance", v)} />
                    </td>
                    {Array.from({ length: days }, (_, i) => i + 1).map(d => {
                      const e = getDay(row.store.id, row.ptype.id, d);
                      return (
                        <>
                          <td key={`pc${d}`} className="p-0"><Cell value={e?.posted ?? 0} onSave={(v) => saveCell(row.store.id, row.ptype.id, d, "posted", v)} /></td>
                          <td key={`rc${d}`} className="p-0"><Cell value={e?.returned ?? 0} onSave={(v) => saveCell(row.store.id, row.ptype.id, d, "returned", v)} /></td>
                          <td key={`ac${d}`} className="px-2 py-1 text-right text-muted-foreground bg-muted/20">{fmt(+(e?.actual_balance ?? 0))}</td>
                          <td key={`sc${d}`} className="px-2 py-1 text-right text-foreground bg-accent/5 border-r font-medium">{fmt(+(e?.realized ?? 0))}</td>
                        </>
                      );
                    })}
                  </tr>
                );
              })}
              <tr className="border-t bg-primary/10 font-semibold">
                <td className="sticky left-0 bg-primary/10 px-2 py-2 border-r" colSpan={3}>ИТОГО</td>
                <td className="border-r"></td>
                {Array.from({ length: days }, (_, i) => i + 1).map(d => {
                  let p = 0, r = 0, real = 0;
                  for (const e of entries) if (e.day === d) { p += +e.posted; r += +e.returned; real += +e.realized; }
                  return (
                    <>
                      <td key={`tp${d}`} className="px-1 text-right">{fmt(p)}</td>
                      <td key={`tr${d}`} className="px-1 text-right">{fmt(r)}</td>
                      <td key={`ta${d}`} className="px-1 text-right">—</td>
                      <td key={`ts${d}`} className="px-1 text-right border-r">{fmt(real)}</td>
                    </>
                  );
                })}
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

function Cell({ value, onSave }: { value: number; onSave: (v: number) => void | Promise<void> }) {
  const [v, setV] = useState(String(value || ""));
  const original = useRef(value);
  useEffect(() => { setV(value ? String(value) : ""); original.current = value; }, [value]);
  return (
    <input
      value={v}
      onChange={(e) => setV(e.target.value.replace(/[^\d.,-]/g, ""))}
      onBlur={() => {
        const n = parseFloat(v.replace(",", ".")) || 0;
        if (n !== original.current) onSave(n);
      }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      className="w-14 px-1 py-1 text-right text-xs bg-transparent focus:bg-background focus:outline-none focus:ring-1 focus:ring-ring rounded"
      inputMode="decimal"
    />
  );
}
