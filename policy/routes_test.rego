package repo.policy_test

import data.repo.policy

# A route that satisfies every rule in routes.rego, so each test below changes
# exactly one thing and the failure names itself.
clean_route := {
	"file": "apps/backend/src/app/api/orders/route.ts",
	"apiPath": "orders",
	"methods": ["GET"],
	"authHelpers": ["requireAuth"],
	"dynamicSegments": [],
	"lines": 40,
	"safeIdSegments": [],
	"unattributedSafeIdParses": 0,
	"unsafeIdParses": [],
	"testFiles": ["apps/backend/src/app/api/orders/route.test.ts"],
}

rules(violations) := {v.rule | some v in violations}

# --- rule 1 ----------------------------------------------------------------

test_route_without_auth_is_denied if {
	route := object.union(clean_route, {"authHelpers": []})
	denied := policy.deny with input as {"routes": [route]}
	"route_requires_auth" in rules(denied)
}

test_route_with_requireRole_is_allowed if {
	route := object.union(clean_route, {"authHelpers": ["requireRole"]})
	denied := policy.deny with input as {"routes": [route]}
	not "route_requires_auth" in rules(denied)
}

test_allowlisted_route_is_allowed if {
	route := object.union(clean_route, {"apiPath": "health", "authHelpers": []})
	denied := policy.deny with input as {"routes": [route]}
	not "route_requires_auth" in rules(denied)
}

# A route module that exports no handler is a helper, not an endpoint.
test_route_with_no_methods_is_not_checked if {
	route := object.union(clean_route, {"authHelpers": [], "methods": []})
	denied := policy.deny with input as {"routes": [route]}
	count(denied) == 0
}

test_violation_names_the_file_and_the_reason if {
	route := object.union(clean_route, {"authHelpers": []})
	denied := policy.deny with input as {"routes": [route]}
	some v in denied
	v.rule == "route_requires_auth"
	v.file == "apps/backend/src/app/api/orders/route.ts"
	contains(v.detail, "orders")
	contains(v.why, "#131")
}

# --- rule 5 ----------------------------------------------------------------

test_parseInt_on_a_path_segment_is_denied if {
	route := object.union(clean_route, {
		"dynamicSegments": ["[id]"],
		"unsafeIdParses": [{"line": 12, "call": "parseInt(id, 10)", "segment": "id"}],
	})
	denied := policy.deny with input as {"routes": [route]}
	"route_id_parsed_safely" in rules(denied)

	# The unsafe-parse rule fires; the never-called rule must not double-report.
	count(denied) == 1
}

test_dynamic_route_that_never_parses_an_id_is_denied if {
	route := object.union(clean_route, {"dynamicSegments": ["[id]"]})
	denied := policy.deny with input as {"routes": [route]}
	"route_id_parsed_safely" in rules(denied)
}

test_parseRouteId_satisfies_rule_5 if {
	route := object.union(clean_route, {"dynamicSegments": ["[id]"], "safeIdSegments": ["id"]})
	denied := policy.deny with input as {"routes": [route]}
	count(denied) == 0
}

# `parseInt(searchParams.get('scopeId'))` is a query parameter, not a path id;
# the extractor only records bindings destructured from `params`, so a static
# route has nothing for rule 5 to check.
test_static_route_is_not_checked_for_ids if {
	denied := policy.deny with input as {"routes": [clean_route]}
	count(denied) == 0
}

# The hole this rule had until #191's review: `safeIdParses` was a file-wide
# counter, so parsing the FIRST segment vouched for every other one. This is the
# real route that exercised it — sourceId goes through parseRouteId, projectId is
# handed to the CI client raw.
test_parsing_one_segment_does_not_vouch_for_the_next if {
	route := object.union(clean_route, {
		"file": "apps/backend/src/app/api/admin/products/[id]/environments/[envId]/route.ts",
		"apiPath": "admin/products/[id]/environments/[envId]",
		"dynamicSegments": ["[id]", "[envId]"],
		"safeIdSegments": ["id"],
	})
	denied := policy.deny with input as {"routes": [route]}
	some v in denied
	v.rule == "route_id_parsed_safely"
	contains(v.detail, "[envId]")

	# And it says what the route did parse, so the report is actionable.
	contains(v.detail, "(id does)")

	# Exactly one: the covered segment must not be reported as well.
	count(denied) == 1
}

test_every_segment_parsed_passes if {
	route := object.union(clean_route, {
		"apiPath": "admin/products/[id]/environments/[envId]",
		"dynamicSegments": ["[id]", "[envId]"],
		"safeIdSegments": ["envId", "id"],
	})
	denied := policy.deny with input as {"routes": [route]}
	count(denied) == 0
}

# `[lang]` and the CI provider's `[projectId]` are not row ids. Exempting them
# costs a line in `non_id_segments` and a sentence in review, which is the point —
# the previous rule exempted them by accident and everything else with them.
test_an_allowlisted_non_id_segment_passes if {
	route := object.union(clean_route, {
		"file": "apps/backend/src/app/api/admin/products/[id]/translations/[lang]/route.ts",
		"apiPath": "admin/products/[id]/translations/[lang]",
		"dynamicSegments": ["[id]", "[lang]"],
		"safeIdSegments": ["id"],
	})
	denied := policy.deny with input as {"routes": [route]}
	count(denied) == 0
}

# The allowlist is keyed by route and segment, so an exemption in one route does
# not travel to a segment of the same name somewhere else.
test_the_allowlist_does_not_travel_to_another_route if {
	route := object.union(clean_route, {
		"apiPath": "admin/other/[lang]",
		"dynamicSegments": ["[lang]"],
	})
	denied := policy.deny with input as {"routes": [route]}
	count(denied) == 1
}

# --- rule 10 ---------------------------------------------------------------

# A deny since #181: the count reached zero — the two size routes it named, plus
# five more that had appeared since — and a rule that has ever been at zero can
# be held there.
test_a_route_with_no_test_is_denied if {
	route := object.union(clean_route, {"testFiles": []})
	denied := policy.deny with input as {"routes": [route]}
	"route_has_a_test" in rules(denied)
	some v in denied
	contains(v.detail, "no route.test.ts imports this module")
}

# A module that exports no handler is not a route, whatever it is called.
test_a_module_with_no_methods_is_not_a_route if {
	route := object.union(clean_route, {"testFiles": [], "methods": []})
	denied := policy.deny with input as {"routes": [route]}
	count([v | some v in denied; v.rule == "route_has_a_test"]) == 0
}

test_route_covered_from_a_sibling_directory_passes if {
	route := object.union(clean_route, {
		"file": "apps/backend/src/app/api/sessions/[id]/route.ts",
		"apiPath": "sessions/[id]",
		"dynamicSegments": ["[id]"],
		"safeIdSegments": ["id"],
		"testFiles": ["apps/backend/src/app/api/sessions/route.test.ts"],
	})
	warned := policy.warn with input as {"routes": [route]}
	denied := policy.deny with input as {"routes": [route]}
	count(warned) == 0
	count([v | some v in denied; v.rule == "route_has_a_test"]) == 0
}

# --- rule 11 ---------------------------------------------------------------

test_long_route_warns_and_never_denies if {
	route := object.union(clean_route, {"lines": policy.max_route_lines + 1})
	warned := policy.warn with input as {"routes": [route]}
	denied := policy.deny with input as {"routes": [route]}
	"route_file_is_small" in rules(warned)
	count(denied) == 0
}

test_route_at_the_limit_is_fine if {
	route := object.union(clean_route, {"lines": policy.max_route_lines})
	warned := policy.warn with input as {"routes": [route]}
	count(warned) == 0
}

# --- server-only modules must not be reachable from a client component ------

client_imports(hits) := {"clientImports": hits}

server_only_denials(hits) := [v |
	some v in policy.deny with input as client_imports(hits)
	v.rule == "server_only_module_not_in_client"
]

test_client_component_importing_serverapi_is_denied if {
	denied := server_only_denials([{
		"file": "apps/frontend/src/components/ui/RefreshButton.tsx",
		"line": 4,
		"module": "@/lib/serverApi",
	}])
	count(denied) == 1
	denied[0].line == 4
	contains(denied[0].detail, "@/lib/serverApi")
	contains(denied[0].why, "browser bundle")
}

test_client_component_importing_auth_is_denied if {
	denied := server_only_denials([{
		"file": "apps/frontend/src/components/x/Thing.tsx",
		"line": 2,
		"module": "@/lib/auth",
	}])
	count(denied) == 1
}

# The state this rule merged in, and the state it exists to keep.
test_no_client_import_of_a_server_module_is_allowed if {
	count(server_only_denials([])) == 0
}

test_each_offending_import_is_reported if {
	count(server_only_denials([
		{"file": "a.tsx", "line": 1, "module": "@/lib/serverApi"},
		{"file": "b.tsx", "line": 9, "module": "@/lib/auth"},
	])) == 2
}

# --- a catch around a server fetch must rethrow the navigation --------------

swallowed(entries) := {"swallowedRedirects": entries}

hit(file, kind) := {
	"file": file,
	"line": 32,
	"kind": kind,
	"call": "get",
}

test_no_swallowed_redirects_passes if {
	denied := policy.deny with input as swallowed([])
	count(denied) == 0
}

# The #434 shape: `try { await get(...) } catch { notFound() }`.
test_a_try_catch_without_a_rethrow_is_denied if {
	facts := swallowed([hit("apps/frontend/src/app/(dashboard)/projects/[id]/page.tsx", "try/catch")])
	denied := policy.deny with input as facts
	some v in denied
	v.rule == "catch_rethrows_navigation"
	v.line == 32
}

# The same hazard wearing a promise method.
test_a_promise_catch_without_a_rethrow_is_denied if {
	facts := swallowed([hit("apps/frontend/src/app/(dashboard)/catalog/[id]/page.tsx", ".catch(...)")])
	denied := policy.deny with input as facts
	some v in denied
	v.rule == "catch_rethrows_navigation"
}

# Both are reported, so fixing one does not hide the other.
test_every_swallow_is_reported if {
	facts := swallowed([
		hit("apps/frontend/src/app/a/page.tsx", "try/catch"),
		hit("apps/frontend/src/app/b/page.tsx", ".catch(...)"),
	])
	denied := policy.deny with input as facts
	count([v | some v in denied; v.rule == "catch_rethrows_navigation"]) == 2
}
