
-- Phase 2/3 additions
ALTER TABLE public.daily_entries ADD COLUMN IF NOT EXISTS written_off numeric NOT NULL DEFAULT 0;
ALTER TABLE public.product_types ADD COLUMN IF NOT EXISTS price numeric;

-- manager_stores
CREATE TABLE IF NOT EXISTS public.manager_stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, store_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.manager_stores TO authenticated;
GRANT ALL ON public.manager_stores TO service_role;
ALTER TABLE public.manager_stores ENABLE ROW LEVEL SECURITY;

CREATE POLICY "MS: user reads own" ON public.manager_stores FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "MS: admin write" ON public.manager_stores FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin'))
  WITH CHECK (public.has_role(auth.uid(),'admin'));

-- helper: store visible to user
CREATE OR REPLACE FUNCTION public.can_access_store(_user_id uuid, _store_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    public.has_role(_user_id, 'admin'::public.app_role)
    OR NOT EXISTS (SELECT 1 FROM public.manager_stores WHERE user_id = _user_id)
    OR EXISTS (SELECT 1 FROM public.manager_stores WHERE user_id = _user_id AND store_id = _store_id);
$$;
REVOKE EXECUTE ON FUNCTION public.can_access_store(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_access_store(uuid, uuid) TO authenticated, service_role;

-- Restrict stores by manager assignment
DROP POLICY IF EXISTS "Stores: read auth" ON public.stores;
CREATE POLICY "Stores: read scoped" ON public.stores FOR SELECT TO authenticated
  USING (public.can_access_store(auth.uid(), id));

-- Restrict daily_entries by manager assignment
DROP POLICY IF EXISTS "DE: read auth" ON public.daily_entries;
CREATE POLICY "DE: read scoped" ON public.daily_entries FOR SELECT TO authenticated
  USING (public.can_access_store(auth.uid(), store_id));

DROP POLICY IF EXISTS "DE: insert admin or operator" ON public.daily_entries;
CREATE POLICY "DE: insert scoped operator" ON public.daily_entries FOR INSERT TO authenticated
  WITH CHECK (
    (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'operator'))
    AND public.can_access_store(auth.uid(), store_id)
  );

DROP POLICY IF EXISTS "DE: update admin or operator" ON public.daily_entries;
CREATE POLICY "DE: update scoped operator" ON public.daily_entries FOR UPDATE TO authenticated
  USING (
    (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'operator'))
    AND public.can_access_store(auth.uid(), store_id)
  )
  WITH CHECK (
    (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'operator'))
    AND public.can_access_store(auth.uid(), store_id)
  );

-- Enable realtime
ALTER TABLE public.daily_entries REPLICA IDENTITY FULL;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='daily_entries'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.daily_entries';
  END IF;
END $$;
