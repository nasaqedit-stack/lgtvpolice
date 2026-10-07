-- Prevent direct RPC execution of the internal auth trigger function.
revoke all on function public.handle_new_user() from public, anon, authenticated;
