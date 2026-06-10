
CREATE TABLE public.counterparties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.counterparties TO authenticated;
GRANT ALL ON public.counterparties TO service_role;

ALTER TABLE public.counterparties ENABLE ROW LEVEL SECURITY;

CREATE POLICY "CP: read auth" ON public.counterparties FOR SELECT TO authenticated USING (true);
CREATE POLICY "CP: admin write" ON public.counterparties FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER counterparties_touch_updated_at
  BEFORE UPDATE ON public.counterparties
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.stores
  ADD COLUMN counterparty_id uuid REFERENCES public.counterparties(id) ON DELETE SET NULL;

CREATE INDEX stores_counterparty_id_idx ON public.stores(counterparty_id);
