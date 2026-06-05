import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const createSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(100),
  role: z.enum(["admin", "operator"]),
});

export const createUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => createSchema.parse(data))
  .handler(async ({ data, context }) => {
    // Verify caller is admin
    const { data: me } = await context.supabase.from("profiles").select("role").eq("id", context.userId).maybeSingle();
    if (!me || (me as { role: string }).role !== "admin") throw new Error("Forbidden");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
      user_metadata: { name: data.name },
    });
    if (error) throw new Error(error.message);
    if (created.user) {
      await supabaseAdmin.from("profiles").upsert({
        id: created.user.id, name: data.name, email: data.email, role: data.role, is_active: true,
      });
    }
    return { ok: true };
  });

export const deleteUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => z.object({ userId: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    const { data: me } = await context.supabase.from("profiles").select("role").eq("id", context.userId).maybeSingle();
    if (!me || (me as { role: string }).role !== "admin") throw new Error("Forbidden");
    if (data.userId === context.userId) throw new Error("Нельзя удалить себя");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.auth.admin.deleteUser(data.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const setUserActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => z.object({ userId: z.string().uuid(), isActive: z.boolean() }).parse(data))
  .handler(async ({ data, context }) => {
    const { data: me } = await context.supabase.from("profiles").select("role").eq("id", context.userId).maybeSingle();
    if (!me || (me as { role: string }).role !== "admin") throw new Error("Forbidden");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("profiles").update({ is_active: data.isActive }).eq("id", data.userId);
    return { ok: true };
  });
