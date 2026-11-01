-- Applied once the app that records big and damaged eggs is live:
-- the older functions cannot record those grades, so they are retired.
revoke execute on function
  public.rpc_collect(text, int, int, int), public.rpc_receive(bigint, int, int, int), public.rpc_sale(text, int, int, int, numeric, numeric, numeric, text),
  public.rpc_stock_count(text, text, int, int, int), public.rpc_close_day(text, int, int, int, numeric), public.rpc_dispatch(text, text, int, int, int, text)
from authenticated;
