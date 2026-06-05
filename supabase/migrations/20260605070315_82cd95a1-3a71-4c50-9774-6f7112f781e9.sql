
-- Roles enum
CREATE TYPE public.app_role AS ENUM ('admin', 'operator');

-- Profiles table
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  role public.app_role NOT NULL DEFAULT 'operator',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Security definer role helper
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = _user_id AND role = _role AND is_active = true);
$$;

CREATE POLICY "Profiles: self read" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "Profiles: admin read all" ON public.profiles FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin'));
CREATE POLICY "Profiles: admin manage" ON public.profiles FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

-- Stores
CREATE TABLE public.stores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  address TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stores TO authenticated;
GRANT ALL ON public.stores TO service_role;
ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Stores: read auth" ON public.stores FOR SELECT TO authenticated USING (true);
CREATE POLICY "Stores: admin write" ON public.stores FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

-- Product types
CREATE TABLE public.product_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_types TO authenticated;
GRANT ALL ON public.product_types TO service_role;
ALTER TABLE public.product_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY "PT: read auth" ON public.product_types FOR SELECT TO authenticated USING (true);
CREATE POLICY "PT: admin write" ON public.product_types FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

-- Daily entries (one row per store/product/year/month/day)
CREATE TABLE public.daily_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  product_type_id UUID NOT NULL REFERENCES public.product_types(id) ON DELETE CASCADE,
  year INT NOT NULL,
  month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  day INT NOT NULL CHECK (day BETWEEN 1 AND 31),
  posted NUMERIC NOT NULL DEFAULT 0,
  returned NUMERIC NOT NULL DEFAULT 0,
  actual_balance NUMERIC NOT NULL DEFAULT 0,
  realized NUMERIC NOT NULL DEFAULT 0,
  opening_balance NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, product_type_id, year, month, day)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.daily_entries TO authenticated;
GRANT ALL ON public.daily_entries TO service_role;
ALTER TABLE public.daily_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "DE: read auth" ON public.daily_entries FOR SELECT TO authenticated USING (true);
CREATE POLICY "DE: write auth" ON public.daily_entries FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "DE: update auth" ON public.daily_entries FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "DE: admin delete" ON public.daily_entries FOR DELETE TO authenticated USING (public.has_role(auth.uid(),'admin'));

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TRIGGER trg_profiles_u BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER trg_stores_u BEFORE UPDATE ON public.stores FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER trg_de_u BEFORE UPDATE ON public.daily_entries FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Auto-create profile on signup (default operator). First user becomes admin.
CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count INT;
  v_role public.app_role;
BEGIN
  SELECT COUNT(*) INTO v_count FROM public.profiles;
  IF v_count = 0 THEN v_role := 'admin'; ELSE v_role := 'operator'; END IF;
  INSERT INTO public.profiles(id, name, email, role)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email,'@',1)), NEW.email, v_role);
  RETURN NEW;
END $$;

CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
