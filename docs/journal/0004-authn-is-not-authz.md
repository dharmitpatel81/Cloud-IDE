# 0004 — Being logged in is not the same as being allowed
Date: 2026-09-12 · Phase: 4

**Built:** Email and password accounts with scrypt hashing, server-side
sessions in an httpOnly cookie, and projects owned by users. Postgres in
Compose, Drizzle for the schema. Three project routes: create one, list mine,
open one by id. Every route reads the session cookie and rejects you if you
aren't signed in, which felt like the job was done.

**Broke:** Registered two accounts. Alice made a project, Bob made his own.
Bob's project list correctly showed only Bob's. Then Bob requested Alice's
project id directly and got HTTP 200 with the whole thing. The response even
included `ownerId`, Alice's user id, so the server knew perfectly well the
project wasn't his and handed it over anyway. Then opened a WebSocket to the
collab room with no cookie at all, no account, never registered. It connected.

**Measured:** Of the four entry points that touch a protected resource, one
does the check. `GET /projects` is correctly scoped to the owner.
`GET /projects/:id` authenticates and never authorizes. `POST /run` and the
WebSocket upgrade require nothing whatsoever, so two of the four don't even
ask who you are. One in four.

**Fixed:** Scope the query rather than checking after the fact. `GET
/projects/:id` now filters on id *and* `ownerId`, so an unauthorized project
comes back as "not found" rather than being fetched and then rejected — the
row never leaves the database. `POST /run` requires a session. The WebSocket
upgrade resolves the session cookie and the project's owner before the socket
exists, and rejects the handshake otherwise. The general rule that came out of
it: **authentication is a property of the request, authorization is a property
of the request and one specific resource.** A session proves who you are and
nothing more, so every entry point has to ask its own question, and a
WebSocket upgrade is an entry point even though it doesn't look like one.

**Would do differently:** Notice when a variable is loaded, validated, and
then never used again. In the broken route, `user` was fetched, checked for
existence, and then took no part in the query — that's the whole bug, visible
without knowing anything about auth. Also worth internalising: `POST /run` had
been unauthenticated since Phase 1 and nobody noticed, because it never looked
like an auth problem, it looked like a code runner. Entry points accumulate
quietly, and the ones that predate your auth system are the ones that never
get retrofitted.
