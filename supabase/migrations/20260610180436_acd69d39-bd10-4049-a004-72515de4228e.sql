
-- 1. Add 'viewer' to app_role enum
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'viewer';

-- 2. Tighten daily_entries write policies (admin OR operator only)
DROP POLICY IF EXISTS "DE: insert auth" ON public.daily_entries;
DROP POLICY IF EXISTS "DE: update auth" ON public.daily_entries;

CREATE POLICY "DE: insert admin or operator" ON public.daily_entries
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_role(auth.uid(), 'admin'::public.app_role)
    OR public.has_role(auth.uid(), 'operator'::public.app_role)
  );

CREATE POLICY "DE: update admin or operator" ON public.daily_entries
  FOR UPDATE TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin'::public.app_role)
    OR public.has_role(auth.uid(), 'operator'::public.app_role)
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'admin'::public.app_role)
    OR public.has_role(auth.uid(), 'operator'::public.app_role)
  );

-- 3. Revoke direct EXECUTE on internal SECURITY DEFINER trigger helpers
REVOKE EXECUTE ON FUNCTION public.touch_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
