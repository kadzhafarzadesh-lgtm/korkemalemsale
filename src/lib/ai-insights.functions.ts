import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { generateText } from "ai";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";

type RawEntry = {
  store_id: string;
  product_type_id: string;
  year: number;
  month: number;
  day: number;
  posted: number;
  returned: number;
  opening_balance: number;
  actual_balance: number | null;
};

function computeMetrics(rows: RawEntry[]) {
  const grouped = new Map<string, RawEntry[]>();
  for (const e of rows) {
    const k = `${e.store_id}|${e.product_type_id}|${e.month}`;
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k)!.push(e);
  }
  let posted = 0, returned = 0, realized = 0;
  const byMonth: Record<number, { posted: number; returned: number; realized: number }> = {};
  const byStore = new Map<string, { posted: number; returned: number; realized: number }>();
  const byProduct = new Map<string, { posted: number; returned: number; realized: number }>();
  for (const [k, list] of grouped) {
    const [store_id, product_type_id, mStr] = k.split("|");
    const m = Number(mStr);
    list.sort((a, b) => a.day - b.day);
    const opening = +(list.find((d) => d.day === 1)?.opening_balance ?? 0);
    let prevEff = opening;
    let rPosted = 0, rReturned = 0, rRealized = 0;
    for (const d of list) {
      const base = d.day === 1 ? opening : prevEff;
      const manual = d.actual_balance == null ? null : +d.actual_balance;
      const eff = manual != null ? manual : base + (+d.posted) - (+d.returned);
      const real = manual != null ? base + +d.posted - +d.returned - manual : 0;
      rRealized += real;
      rPosted += +d.posted;
      rReturned += +d.returned;
      prevEff = eff;
    }
    posted += rPosted; returned += rReturned; realized += rRealized;
    byMonth[m] = byMonth[m] ?? { posted: 0, returned: 0, realized: 0 };
    byMonth[m].posted += rPosted; byMonth[m].returned += rReturned; byMonth[m].realized += rRealized;
    const s = byStore.get(store_id) ?? { posted: 0, returned: 0, realized: 0 };
    s.posted += rPosted; s.returned += rReturned; s.realized += rRealized;
    byStore.set(store_id, s);
    const p = byProduct.get(product_type_id) ?? { posted: 0, returned: 0, realized: 0 };
    p.posted += rPosted; p.returned += rReturned; p.realized += rRealized;
    byProduct.set(product_type_id, p);
  }
  return { posted, returned, realized, byMonth, byStore, byProduct };
}

export const getDailyInsights = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const today = new Date().toISOString().slice(0, 10);
    const { supabase } = context;

    const { data: existing } = await supabase
      .from("ai_insights")
      .select("content, created_at, insight_date, model")
      .eq("insight_date", today)
      .maybeSingle();
    if (existing) return existing;

    const lovableKey = process.env.LOVABLE_API_KEY;
    if (!lovableKey) throw new Error("LOVABLE_API_KEY missing");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const year = new Date().getFullYear();
    const [{ data: entries }, { data: stores }, { data: ptypes }] = await Promise.all([
      supabaseAdmin
        .from("daily_entries")
        .select("store_id,product_type_id,year,month,day,posted,returned,opening_balance,actual_balance")
        .eq("year", year)
        .limit(50000),
      supabaseAdmin.from("stores").select("id,name").eq("is_active", true),
      supabaseAdmin.from("product_types").select("id,name"),
    ]);

    const rows = (entries ?? []) as RawEntry[];
    if (rows.length === 0) {
      const empty = {
        insight_date: today,
        content: "Пока нет данных за текущий год для анализа. Заполните дневные показатели — и ИИ предложит инсайты завтра.",
        model: null,
        created_at: new Date().toISOString(),
      };
      await supabaseAdmin.from("ai_insights").insert({ insight_date: today, content: empty.content });
      return empty;
    }

    const m = computeMetrics(rows);
    const storeMap = new Map((stores ?? []).map((s: any) => [s.id, s.name]));
    const productMap = new Map((ptypes ?? []).map((p: any) => [p.id, p.name]));

    const topStores = [...m.byStore.entries()]
      .map(([id, v]) => ({ name: storeMap.get(id) ?? "—", ...v, retPct: v.posted > 0 ? (v.returned / v.posted) * 100 : 0 }))
      .sort((a, b) => b.realized - a.realized)
      .slice(0, 10);
    const worstReturns = [...m.byStore.entries()]
      .map(([id, v]) => ({ name: storeMap.get(id) ?? "—", ...v, retPct: v.posted > 0 ? (v.returned / v.posted) * 100 : 0 }))
      .filter(s => s.posted > 50)
      .sort((a, b) => b.retPct - a.retPct)
      .slice(0, 5);
    const byProduct = [...m.byProduct.entries()].map(([id, v]) => ({ name: productMap.get(id) ?? "—", ...v }));
    const byMonth = Object.entries(m.byMonth).map(([mo, v]) => ({ month: Number(mo), ...v })).sort((a, b) => a.month - b.month);

    const summary = {
      year,
      totals: { posted: m.posted, returned: m.returned, realized: m.realized, returnPct: m.posted > 0 ? +(m.returned / m.posted * 100).toFixed(2) : 0 },
      monthly: byMonth,
      topStores,
      worstReturns,
      byProduct,
    };

    const gateway = createLovableAiGatewayProvider(lovableKey);
    const model = "google/gemini-3-flash-preview";

    const prompt = `Ты — аналитик B2B-продаж полуфабрикатов. На основе данных за ${year} год дай краткие, конкретные инсайты на русском языке для руководителя.

Данные (агрегированные):
${JSON.stringify(summary, null, 2)}

Сформируй ответ в Markdown:
- 3–5 ключевых наблюдений (тренды по месяцам, лидеры, аномалии)
- 2–3 проблемные точки (высокий % возвратов, падения)
- 2–3 практические рекомендации

Будь конкретным: называй магазины, продукты, цифры. Не повторяй сырые JSON-данные.`;

    let content = "";
    try {
      const { text } = await generateText({
        model: gateway(model),
        prompt,
      });
      content = text.trim();
    } catch (e: any) {
      const status = e?.statusCode ?? e?.status;
      if (status === 429) throw new Error("Слишком много запросов к ИИ. Попробуйте позже.");
      if (status === 402) throw new Error("Исчерпан лимит ИИ. Добавьте кредиты в рабочем пространстве.");
      throw new Error("Не удалось сгенерировать инсайты: " + (e?.message ?? "unknown"));
    }

    const { data: inserted } = await supabaseAdmin
      .from("ai_insights")
      .insert({ insight_date: today, content, model, metrics: summary as any })
      .select("content, created_at, insight_date, model")
      .single();
    return inserted ?? { insight_date: today, content, model, created_at: new Date().toISOString() };
  });
