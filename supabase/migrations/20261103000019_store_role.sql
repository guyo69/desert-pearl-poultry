-- 3 Nov 2026, client request: a new role, the inventory clerk ("store"), who
-- runs the farm store (feed, medicine and other supplies). On its own because
-- a new enum value can only be used once this has been committed.
alter type public.staff_role add value if not exists 'store' after 'clerk';
