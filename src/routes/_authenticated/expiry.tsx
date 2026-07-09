import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Loader2, AlertTriangle, Clock, CheckCircle2, XCircle, Trash2, Coins } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth-context";
import { getExpiryReport, writeOffBatch, type ExpiryBatch } from "@/lib/expiry.functions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/expiry")({
  component: ExpiryPage,
  errorComponent: ({ error }) => (
    <div className="p-6 text-destructive">{error.message}</div>
  ),
  notFoundComponent: () => <div className="p-6">Не найдено</div>,
});

function ExpiryPage() {
  const fetchReport = useServerFn(getExpiryReport);
  const writeOff = useServerFn(writeOffBatch);
  const qc = useQueryClient();
  const { canWrite } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ["expiry-report"],
    queryFn: () => fetchReport({}),
    staleTime: 5 * 60_000,
  });

  const { data: stores = [] } = useQuery({
    queryKey: ["stores"],
    queryFn: async () =>
      (await supabase.from("stores").select("id,name").eq("is_active", true).order("sort_order").order("name")).data ?? [],
  });

  const [storeFilter, setStoreFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);

  const batches = data?.batches ?? [];
  const filtered = useMemo(() => {
    let list = batches;
    if (storeFilter !== "all") list = list.filter((b) => b.store_id === storeFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (b) => b.product_name.toLowerCase().includes(q) || b.store_name.toLowerCase().includes(q),
      );
    }
    if (!showAll) list = list.filter((b) => b.days_left < 5);
    return list;
  }, [batches, storeFilter, search, showAll]);

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Сроки годности</h1>
          <p className="text-sm text-muted-foreground">
            Партии с истекающим сроком · по методу FIFO · на {data?.today ?? "—"}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Просрочено" value={data?.totals.expired ?? 0} icon={XCircle} tone="destructive" />
        <StatCard label="< 3 дней" value={data?.totals.critical ?? 0} icon={AlertTriangle} tone="warning" />
        <StatCard label="< 5 дней" value={data?.totals.warning ?? 0} icon={Clock} tone="amber" />
        <StatCard label="В норме" value={data?.totals.ok ?? 0} icon={CheckCircle2} tone="ok" />
      </div>

      <Card className="p-4 space-y-3">
        <div className="flex flex-wrap gap-2 items-center">
          <Select value={storeFilter} onValueChange={setStoreFilter}>
            <SelectTrigger className="w-48"><SelectValue placeholder="Магазин" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все магазины</SelectItem>
              {stores.map((s: any) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Input
            placeholder="Поиск по продукции или магазину…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 min-w-48 max-w-sm"
          />
          <label className="flex items-center gap-2 text-sm text-muted-foreground ml-auto">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
              className="accent-primary"
            />
            Показать все партии
          </label>
        </div>

        {isLoading ? (
          <div className="py-12 text-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin inline" /></div>
        ) : filtered.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground text-sm">
            {showAll ? "Партии не найдены" : "🎉 Нет партий со сроком < 5 дней"}
          </div>
        ) : (
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead className="text-muted-foreground text-left text-xs uppercase">
                <tr>
                  <th className="py-2 px-2">Статус</th>
                  <th className="px-2">Магазин</th>
                  <th className="px-2">Продукция</th>
                  <th className="px-2 text-right">Остаток</th>
                  <th className="px-2">Поступление</th>
                  <th className="px-2">Срок до</th>
                  <th className="px-2 text-right">Дней</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((b, i) => <BatchRow key={i} b={b} />)}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="text-xs text-muted-foreground">
        ⓘ Партии помечены «прибл.» если рассчитаны из начального остатка без даты поступления.
        Списания и возвраты вычитаются по принципу FIFO — первым уходит самый старый товар.
      </p>
    </div>
  );
}

function statusTone(days: number) {
  if (days < 0) return { label: "Просрочено", className: "bg-destructive/10 text-destructive border-destructive/30" };
  if (days < 3) return { label: "Критично", className: "bg-orange-500/10 text-orange-600 border-orange-500/30 dark:text-orange-400" };
  if (days < 5) return { label: "Внимание", className: "bg-amber-500/10 text-amber-700 border-amber-500/30 dark:text-amber-400" };
  return { label: "В норме", className: "bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-400" };
}

function BatchRow({ b }: { b: ExpiryBatch }) {
  const tone = statusTone(b.days_left);
  return (
    <tr className="border-t">
      <td className="py-2 px-2">
        <Badge variant="outline" className={cn("text-xs", tone.className)}>{tone.label}</Badge>
      </td>
      <td className="px-2">{b.store_name}</td>
      <td className="px-2">
        {b.product_name}
        {b.is_synthetic && <span className="ml-2 text-[10px] text-muted-foreground">прибл.</span>}
      </td>
      <td className="px-2 text-right tabular-nums">{b.qty}</td>
      <td className="px-2 text-muted-foreground tabular-nums">{b.received_date}</td>
      <td className="px-2 tabular-nums">{b.expires_at}</td>
      <td className={cn("px-2 text-right tabular-nums font-medium", b.days_left < 0 ? "text-destructive" : b.days_left < 3 ? "text-orange-600 dark:text-orange-400" : b.days_left < 5 ? "text-amber-700 dark:text-amber-400" : "")}>
        {b.days_left < 0 ? `${b.days_left}` : b.days_left}
      </td>
    </tr>
  );
}

function StatCard({ label, value, icon: Icon, tone }: { label: string; value: number; icon: any; tone: "destructive" | "warning" | "amber" | "ok" }) {
  const colors = {
    destructive: "text-destructive bg-destructive/10",
    warning: "text-orange-600 bg-orange-500/10 dark:text-orange-400",
    amber: "text-amber-700 bg-amber-500/10 dark:text-amber-400",
    ok: "text-emerald-700 bg-emerald-500/10 dark:text-emerald-400",
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
