# Rules about `apps/backend/src/app/api/**/route.ts`.
package repo.policy

# ---------------------------------------------------------------------------
# rule 1 — every route authenticates, or is on this list
# ---------------------------------------------------------------------------

# The routes that answer without a user session, and what stands in for one.
#
# Exact paths, not `public/*` and `webhooks/*` globs: a new endpoint under
# `webhooks/` is exactly the kind of thing that should cost a line in this file
# and a sentence in a review, rather than inheriting an exemption by living in
# the right directory.
public_routes := {
	"health": "the container health probe and the e2e readiness gate — it has to answer before anything is configured",
	"auth/login": "issues the session; requiring one would be the login endpoint that demands a login",
	"auth/callback": "the SSO redirect target; the identity provider is the caller and it carries no portal session",
	"auth/login/mfa": "second half of the two-step login (#36) — the caller has no session yet, and the signed challenge from /auth/login is the proof this route checks",
	"auth/login/webauthn/options": "the middle of a two-step login with a security key (#197) — the caller has no session yet, and the same signed challenge from /auth/login, checked against the account's current password hash, is the proof this route checks. It opens nothing: it returns the WebAuthn request options and the assertion is still redeemed at auth/login/mfa",
	"auth/webauthn/options": "the FIRST step of a passwordless sign-in (#241) — there is no session and, unlike auth/login/webauthn/options above, no challenge either: the whole point is that no account is named. It returns a random challenge and the RP id, identical whether or not any key is registered, so it discloses nothing to rate-limit an answer out of",
	"auth/webauthn/verify": "redeems a passwordless assertion for a session (#241) — it is the login endpoint for keys, so requiring a session would be the same contradiction as auth/login. The proof it checks is the assertion itself: a challenge this server issued and has not yet spent, a signature over the real origin, and user verification required",
	"public/branding": "the login screen renders from it, before any session exists",
	"public/exchange-rates": "read by the unauthenticated shell for price display",
	"catalog/[id]/image": "loaded by the browser as an <img> src, which cannot carry a bearer token",
	"catalog/[id]/images/[imageId]": "one picture of the gallery (#107) — same reason as catalog/[id]/image above: reached only as an <img> src, and the API is a different origin from the session cookie, so requireAuth would have nothing to read and every picture would be a broken image. Both route ids go through parseRouteId and the service checks the (product, image) pairing, so a URL cannot be walked across products",
	"webhooks/gitlab/pipeline": "authenticated by the environment's callback_secret over HMAC, not by a session",
	"webhooks/github/workflow": "authenticated by the environment's callback_secret over HMAC, not by a session",
	"webhooks/bitbucket/pipeline": "authenticated by the environment's callback_secret over HMAC, not by a session",
	"internal/decommission-sweep": "driven by a scheduler with no user to be; authenticated by DECOMMISSION_SWEEP_SECRET and disabled outright when it is unset",
	"internal/drift-report": "the scheduled drift pipeline reporting what it found (#108); no user to be, authenticated by DRIFT_REPORT_SECRET with the same constant-time compare as the sweep, and disabled outright when it is unset",
	"internal/deployment-window-sweep": "driven by a scheduler with no user to be; authenticated by DEPLOYMENT_WINDOW_SWEEP_SECRET and disabled outright when it is unset — the same shape as internal/decommission-sweep, which it copies deliberately",
	"internal/holiday-refresh": "the same feature's other periodic job (#330): pulls the holiday feed into the database so the decision path never waits on a third party. Authenticated by DEPLOYMENT_WINDOW_SWEEP_SECRET — deliberately the same secret as the sweep it runs beside, because a secret per endpoint is a secret somebody forgets to set — and disabled outright when it is unset",
	"internal/drift-targets": "the other half of the same conversation with the same caller — the work list that pipeline plans against; same secret, same 503 when unset, and it answers for ACTIVE elements only",
}

deny contains v if {
	some route in input.routes
	count(route.methods) > 0
	count(route.authHelpers) == 0
	not public_routes[route.apiPath]

	v := {
		"rule": "route_requires_auth",
		"file": route.file,
		"line": 0,
		"detail": sprintf(
			"exports %s but never calls requireAuth or requireRole, and %q is not on the public allowlist",
			[concat(", ", route.methods), route.apiPath],
		),
		"why": concat("", [
			"Whether a route authenticates is not visible in the file a reviewer is reading — ",
			"it is the absence of a call. #131 and the two IDOR fixes before it were all this shape. ",
			"If the endpoint really is public, add it to `public_routes` in policy/routes.rego with the reason; ",
			"that makes the exemption a reviewable diff instead of an oversight.",
		]),
	}
}

# ---------------------------------------------------------------------------
# rule 5 — route ids go through parseRouteId
# ---------------------------------------------------------------------------

deny contains v if {
	some route in input.routes
	some parse in route.unsafeIdParses

	v := {
		"rule": "route_id_parsed_safely",
		"file": route.file,
		"line": parse.line,
		"detail": sprintf("`%s` reads the `%s` path segment without parseRouteId", [parse.call, parse.segment]),
		"why": concat("", [
			"`parseInt('5abc')` is 5 and `Number('0x10')` is 16, so a malformed id resolves to a real row ",
			"the caller never named — that was #143. `parseRouteId` from lib/http.ts is digits-only and ",
			"safe-integer checked; pair it with `invalidId('...')` for the 400.",
		]),
	}
}

# Path segments that are not row ids, and what they are instead.
#
# Keyed by route and segment, like `intentional_secret_reads`: a route that may
# take a language code in one segment does not thereby get to take an unchecked
# id in another. Exemptions cost a line here and a sentence in review.
non_id_segments := {
	"admin/products/[id]/translations/[lang] lang": "a language code, checked against SUPPORTED_LANGUAGES by upsertTranslation rather than parsed as a number",
	"admin/ci/[sourceId]/projects/[projectId]/branches projectId": "a GitLab project path, URL-encoded — the CI provider's identifier for a repository, not a portal row id",
	"admin/ci/[sourceId]/projects/[projectId]/files projectId": "a GitLab project path, URL-encoded — the CI provider's identifier for a repository, not a portal row id",
	"admin/ci/[sourceId]/projects/[projectId]/import-vars projectId": "a GitLab project path, URL-encoded — the CI provider's identifier for a repository, not a portal row id",
	"admin/products/[id]/sizes/[code] code": "a size code such as XL — the natural key of a matrix row (#249), which is deliberately NOT an id: the same size has a different row id in every environment. The route bounds its length and the service checks it against CODE_PATTERN before it reaches a query",
}

# Every dynamic segment, one at a time.
#
# This used to ask whether the file called `parseRouteId` *at all*, which made one
# safe call vouch for the rest: `/[sourceId]/projects/[projectId]/…` parses
# sourceId and passes projectId through raw, and rule 5 saw a route that parsed an
# id and said nothing. A route's second and third segments are exactly where the
# IDOR bugs were, so coverage has to be per segment.
deny contains v if {
	some route in input.routes
	some segment in route.dynamicSegments
	name := trim_suffix(trim_prefix(segment, "["), "]")
	not name in route.safeIdSegments
	not non_id_segments[sprintf("%s %s", [route.apiPath, name])]

	# The unsafe-parse rule above already reports this segment by name and line.
	count([p | some p in route.unsafeIdParses; p.segment == name]) == 0

	v := {
		"rule": "route_id_parsed_safely",
		"file": route.file,
		"line": 0,
		"detail": sprintf("`%s` never reaches parseRouteId%s", [segment, also_parsed(route)]),
		"why": concat("", [
			"A dynamic segment arrives as an arbitrary string. Reaching the database with it unvalidated is ",
			"how #143's `parseInt` bugs got their reach; `parseRouteId` is the one place that decides what an id is. ",
			"Parsing one segment says nothing about the others. If this segment is not a row id, add ",
			"`<apiPath> <segment>` to `non_id_segments` in policy/routes.rego with what it is instead.",
		]),
	}
}

# Naming what the route *did* parse is what makes a multi-segment report readable:
# "[projectId] never reaches parseRouteId (sourceId does)" is a different sentence
# from "this route never parses an id", and only one of them is true.
also_parsed(route) := "" if count(route.safeIdSegments) == 0

also_parsed(route) := sprintf(" (%s does)", [concat(", ", route.safeIdSegments)]) if count(route.safeIdSegments) > 0

# ---------------------------------------------------------------------------
# rule 10 — every route is exercised by a route test
# ---------------------------------------------------------------------------

# Warn, not deny, until #181 adds the two missing tests.
deny contains v if {
	some route in input.routes
	count(route.methods) > 0
	count(route.testFiles) == 0

	v := {
		"rule": "route_has_a_test",
		"file": route.file,
		"line": 0,
		"detail": sprintf("no route.test.ts imports this module (exports %s)", [concat(", ", route.methods)]),
		"why": concat("", [
			"The service underneath is usually tested; the HTTP surface — the role check, the id parsing, ",
			"the Zod schema, the status codes — is what goes untested and what breaks. ",
			"A deny since #181: the count reached zero, and a rule that has ever been at zero can be ",
			"held there. Membership is by import edge, not by sibling filename, because ",
			"sessions/route.test.ts legitimately covers sessions/[id]/route.ts from one directory over.",
		]),
	}
}

# ---------------------------------------------------------------------------
# rule 11 — advisory size limit
# ---------------------------------------------------------------------------

# Deliberately a warn and deliberately only half of what #149 asked for. The
# other half — "a service function with more than one responsibility" — is not
# mechanically decidable, and a rule that pretended to decide it would be worse
# than no rule. 150 is a guess, calibrated so it reports the two route files that
# already do their own CSV assembly and their own rate limiting inline.
max_route_lines := 150

warn contains v if {
	some route in input.routes
	route.lines > max_route_lines

	v := {
		"rule": "route_file_is_small",
		"file": route.file,
		"line": 0,
		"detail": sprintf("%d lines (advisory limit %d)", [route.lines, max_route_lines]),
		"why": concat("", [
			"A route should parse, authorise and delegate. Past this length it is usually doing the work ",
			"itself, which puts logic behind an HTTP boundary where only an integration test can reach it. ",
			"The threshold is a guess, which is why this never fails a build.",
		]),
	}
}

# ---------------------------------------------------------------------------
# server-only modules must not be reachable from a client component
# ---------------------------------------------------------------------------

# `lib/serverApi.ts` reads `session.apiToken` and statically imports
# `@/lib/auth` to do it. A client component that imports it therefore pulls the
# whole NextAuth server configuration into the browser bundle — which is not a
# hypothetical: the strings `auth/login/mfa` and `NEXTAUTH_SECRET` were in the
# built client chunks once already, and splitting `lib/api` from `lib/serverApi`
# is what took them out (#146).
#
# `serverApi` does carry a runtime guard, and it cannot do this job. The import
# is resolved at BUILD time, so by the time any code runs the auth config is
# already in the chunk; the guard turns a silent leak into a loud failure, which
# is better and is not prevention. Reading the imports is prevention, and it has
# to happen before the build.
#
# Counted against dev: 0. This is a boundary that currently holds, written down
# so it keeps holding.
deny contains v if {
	some hit in input.clientImports

	v := {
		"rule": "server_only_module_not_in_client",
		"file": hit.file,
		"line": hit.line,
		"detail": sprintf("a 'use client' file imports %s", [hit.module]),
		"why": concat("", [
			"This module is server-only: it reads the session and imports the NextAuth server ",
			"configuration. Importing it from a client component puts that configuration in the ",
			"browser bundle. Client components call the API through `@/lib/api`, which reaches the ",
			"backend via `/api/proxy` and never sees the token.",
		]),
	}
}

# ---------------------------------------------------------------------------
# a catch around a server fetch must not swallow the login redirect
# ---------------------------------------------------------------------------

# `lib/serverApi` signals an ended session by THROWING a `redirect()` (#427) —
# which is how Next signals `redirect()` and `notFound()` in general. So a
# `catch` written to tolerate a failed fetch also eats the navigation.
#
# That is not hypothetical either. #434 was twelve server components doing it at
# once: a signed-out user pressing Back got "project not found" for a project
# that exists, and eleven other pages quietly rendered default branding, an empty
# config form or no sessions list instead of the login screen.
#
# It is the THIRD appearance of one hazard — a combinator or a catch that
# tolerates a failure also eats the control flow travelling as one:
#
#   #399  Promise.race   — `() => null` ate the reason a 60s wait rejected in 1s
#   #415  allSettled     — the rejected branch became `[]`, so an outage read as
#                          "there are none"; `lib/section.ts` rethrows for that
#   #434  try / .catch   — this
#
# And a fourth, found on #445 while writing tests AFTER this rule existed:
#
#   #445  allSettled + `if (res.status === 'rejected') notFound()`
#
# `allSettled` collects a thrown `redirect()` as a rejection like any other, so
# that `if` swallows it exactly as a `catch` does — and an ended session was
# reported as a product that does not exist. Two pages had it. The rule covers
# that shape now; the first version did not, which is why it was worth writing a
# test rather than trusting the gate.
#
# The first two were each fixed once and then re-learned. `unstable_rethrow(e)`
# as the first line of the catch is the whole remedy, and this rule is what makes
# it structural instead of remembered.
#
# Only server files are collected: a client component's `get` comes from
# `@/lib/api`, which ends the session in the browser and throws nothing.
#
# Counted against dev: 0. A boundary that currently holds, written down so it
# keeps holding.
deny contains v if {
	some hit in input.swallowedRedirects

	v := {
		"rule": "catch_rethrows_navigation",
		"file": hit.file,
		"line": hit.line,
		"detail": sprintf(
			"a %s around `%s` from @/lib/serverApi does not call unstable_rethrow",
			[hit.kind, hit.call],
		),
		"why": concat("", [
			"`serverApi` turns a 401 into `redirect('/login?expired=1')`, and Next signals that by ",
			"THROWING — so this catch receives the navigation as well as the failures it was written ",
			"for. Swallowing it turns an ended session into a 404, or into a page rendered with ",
			"defaults, where the login screen belongs. Add `unstable_rethrow(e)` as the first line of ",
			"the catch; it rethrows Next's control flow and leaves every other error to you.",
		]),
	}
}
