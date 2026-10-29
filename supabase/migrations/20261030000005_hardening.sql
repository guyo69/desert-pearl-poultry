-- Pin search_path on the small helper functions (Supabase security advisor).
alter function public._eggs(int) set search_path = public;
alter function public._kes(numeric) set search_path = public;
alter function public.buffer_band(numeric) set search_path = public;
alter function public.band_rank(text) set search_path = public;
alter function public.band_label(text) set search_path = public;
alter function public.band_sev(text) set search_path = public;
