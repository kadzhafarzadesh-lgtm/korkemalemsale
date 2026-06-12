CREATE TABLE public.ai_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  insight_date date NOT NULL UNIQUE,
  content text NOT NULL,
  model text,
  metrics jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.ai_insights TO authenticated;
GRANT ALL ON public.ai_insights TO service_role;
ALTER TABLE public.ai_insights ENABLE ROW LEVEL SECURITY;
CREATE POLICY "AI: read for authenticated" ON public.ai_insights FOR SELECT TO authenticated USING (true);