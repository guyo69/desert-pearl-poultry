// Retired on 30 Oct 2026: PIN sign-in was replaced by passwords with two-step
// sign-in (see the `auth` function). Kept as a stub so old app versions get a
// clear answer instead of a working endpoint.
Deno.serve(() => new Response(JSON.stringify({ error: 'This version of the app is out of date. Close it and open it again to update.' }), {
  status: 410, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
}));
