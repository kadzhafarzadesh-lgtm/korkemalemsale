import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Package, AlertTriangle, TrendingUp } from "lucide-react";
import { getExpiryReport } from "@/lib/expiry.functions";
import { productRowStyle, productDotStyle } from "@/lib/product-colors";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/stock")({
  component: StockPage,
  errorComponent: ({ error }) => <div className="p-6 text-destructive">{error.message}</div>,
  notFoundComponent: () => <div className="p-6">Не найдено</div>,
});

function StockPage() {
  const fetchReport = useServerFn(getExpiryReport);
  const { data, isLoading } = useQuery({
    queryKey: ["expiry-report"],
    queryFn: () => fetchReport({}),
    staleTime: 5 * 60_000,
  });

  const { data: stores = [] } = useQuery({
    queryKey: ["stores"],
    queryFn: async () =>
      (await supabase.from("stores").select("id,name,counterparty_id").eq("is_active", true).order("sort_order").order("name")).data ?? [],
  });
  const { data: cps = [] } = useQuery({
    queryKey: ["counterparties"],
    queryFn: async () =>
      (await supabase.from("counterparties").select("id,name").order("sort_order").order("name")).data ?? [],
  });
  const { data: ptypesColors = [] } = useQuery({
    queryKey: ["ptypes"],
    queryFn: async () =>
      (await supabase.from("product_types").select("id,color").order("sort_order").order("name")).data ?? [],
  });
  const colorByPtype = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const p of ptypesColors as any[]) m.set(p.id, p.color ?? null);
    return m;
  }, [ptypesColors]);
  const { data: lastRevs = [] } = useQuery({
    queryKey: ["last-revisions"],
    queryFn: async () =>
      (await supabase
        .from("daily_entries")
        .select("store_id,product_type_id,year,month,day,actual_balance")
        .not("actual_balance", "is", null)
        .order("year", { ascending: false })
        .order("month", { ascending: false })
        .order("day", { ascending: false })
        .limit(5000)
      ).data ?? [],
  });

  const [filterStore, setFilterStore] = useState("all");
  const [filterCp, setFilterCp] = useState("all");
  const [search, setSearch] = useState("");

  const storeById = useMemo(() => new Map((stores as any[]).map((s) => [s.id, s])), [stores]);

  const revByKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of lastRevs as any[]) {
      const k = `${r.store_id}|${r.product_type_id}`;
      if (!m.has(k)) {
        m.set(k, `${r.year}-${String(r.month).padStart(2, "0")}-${String(r.day).padStart(2, "0")}`);
      }
    }
    return m;
  }, [lastRevs]);

  const rows = useMemo(() => {
    if (!data) return [];
    type Row = {
      store_id: string; store_name: string; counterparty_id: string | null;
      product_id: string; product_name: string;
      stock: number; next_expiry: string | null; days_to_expiry: number | null;
      days_since_revision: number | null; low: boolean; overstock: boolean;
    };
    const agg = new Map<string, Row>();
    for (const b of data.batches) {
      const k = `${b.store_id}|${b.product_id}`;
      const cur = agg.get(k);
      if (!cur) {
        const s: any = storeById.get(b.store_id);
        agg.set(k, {
          store_id: b.store_id, store_name: b.store_name, counterparty_id: s?.counterparty_id ?? null,
          product_id: b.product_id, product_name: b.product_name,
          stock: b.qty, next_expiry: b.expires_at, days_to_expiry: b.days_left,
          days_since_revision: null, low: false, overstock: false,
        });
      } else {
        cur.stock += b.qty;
        if (b.days_left < (cur.days_to_expiry ?? Infinity)) {
          cur.days_to_expiry = b.days_left;
          cur.next_expiry = b.expires_at;
        }
      }
    }
    const today = data.today;
    const diff = (a: string, b: string) => {
      const [ay, am, ad] = a.split("-").map(Number);
      const [by, bm, bd] = b.split("-").map(Number);
      return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86400000);
    };
    const out: Row[] = [];
    for (const r of agg.values()) {
      r.stock = Math.round(r.stock * 100) / 100;
      const rev = revByKey.get(`${r.store_id}|${r.product_id}`);
      r.days_since_revision = rev ? diff(today, rev) : null;
      r.low = r.stock > 0 && r.stock < 5;
      r.overstock = r.stock > 100;
      out.push(r);
    }
    let list = out;
    if (filterStore !== "all") list = list.filter((r) => r.store_id === filterStore);
    if (filterCp !== "all") list = list.filter((r) => r.counterparty_id === filterCp);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((r) => r.product_name.toLowerCase().includes(q) || r.store_name.toLowerCase().includes(q));
    }
    list.sort((a, b) => (a.days_to_expiry ?? 9999) - (b.days_to_expiry ?? 9999));
    return list;
  }, [data, revByKey, storeById, filterStore, filterCp, search]);

  const totals = useMemo(() => {
    let low = 0, over = 0;
    for (const r of rows) { if (r.low) low++; if (r.overstock) over++; }
    return { low, over, total: rows.length };
  }, [rows]);

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Остатки</h1>
        <p className="text-sm text-muted-foreground">Эффективный остаток по каждому магазину × продукции</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <StatCard label="Позиций" value={totals.total} icon={Package} tone="default" />
        <StatCard label="Низкий остаток" value={totals.low} icon={AlertTriangle} tone="warning" />
        <StatCard label="Затоваривание" value={totals.over} icon={TrendingUp} tone="amber" />
      </div>

      <Card className="p-4 space-y-3">
        <div className="flex flex-wrap gap-2 items-center">
          <Select value={filterCp} onValueChange={setFilterCp}>
            <SelectTrigger className="w-48"><SelectValue placeholder="Контрагент" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все контрагенты</SelectItem>
              {(cps as any[]).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filterStore} onValueChange={setFilterStore}>
            <SelectTrigger className="w-48"><SelectValue placeholder="Магазин" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все магазины</SelectItem>
              {(stores as any[]).map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Input
            placeholder="Поиск…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 min-w-48 max-w-sm"
          />
        </div>

        {isLoading ? (
          <div className="py-12 text-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin inline" /></div>
        ) : rows.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground text-sm">Нет данных</div>
        ) : (
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead className="text-muted-foreground text-left text-xs uppercase">
                <tr>
                  <th className="py-2 px-2">Магазин</th>
                  <th className="px-2">Продукция</th>
                  <th className="px-2 text-right">Остаток</th>
                  <th className="px-2 text-right">С посл. ревизии</th>
                  <th className="px-2">Ближайшая просрочка</th>
                  <th className="px-2 text-right">Дней</th>
                  <th className="px-2">Флаги</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const color = colorByPtype.get(r.product_id) ?? null;
                  return (
                  <tr key={`${r.store_id}|${r.product_id}`} className="border-t" style={productRowStyle(color)}>
                    <td className="py-2 px-2">{r.store_name}</td>
                    <td className="px-2">
                      <span className="inline-flex items-center gap-2">
                        <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={productDotStyle(color)} aria-hidden />
                        {r.product_name}
                      </span>
                    </td>
                    <td className="px-2 text-right tabular-nums font-medium">{r.stock}</td>
                    <td className="px-2 text-right tabular-nums text-muted-foreground">
                      {r.days_since_revision == null ? "—" : `${r.days_since_revision} дн.`}
                    </td>
                    <td className="px-2 tabular-nums text-muted-foreground">{r.next_expiry ?? "—"}</td>
                    <td className={cn("px-2 text-right tabular-nums",
                      r.days_to_expiry != null && r.days_to_expiry < 0 && "text-destructive",
                      r.days_to_expiry != null && r.days_to_expiry >= 0 && r.days_to_expiry < 5 && "text-amber-600")}>
                      {r.days_to_expiry ?? "—"}
                    </td>
                    <td className="px-2 space-x-1">
                      {r.low && <Badge variant="outline" className="text-xs bg-orange-500/10 text-orange-600 border-orange-500/30">низкий</Badge>}
                      {r.overstock && <Badge variant="outline" className="text-xs bg-amber-500/10 text-amber-700 border-amber-500/30">затоварив.</Badge>}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function StatCard({ label, value, icon: Icon, tone }: { label: string; value: number; icon: any; tone: "default" | "warning" | "amber" }) {
  const colors = {
    default: "text-primary bg-primary/10",
    warning: "text-orange-600 bg-orange-500/10 dark:text-orange-400",
    amber: "text-amber-700 bg-amber-500/10 dark:text-amber-400",
  }[tone];
  return (
    <Card className="p-4 flex items-center gap-3">
      <div className={cn("w-10 h-10 rounded-lg flex items-center justify-center", colors)}>
        <Icon className="w-5 h-5" />
      </div>
      <div>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </div>
    </Card>
  );
}
