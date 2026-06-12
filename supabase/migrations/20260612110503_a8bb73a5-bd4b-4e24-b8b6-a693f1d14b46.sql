ALTER TABLE public.product_types
  ADD COLUMN IF NOT EXISTS shelf_life_days integer NOT NULL DEFAULT 0;