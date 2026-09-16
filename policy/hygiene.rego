# Rules about failures this codebase drops on purpose, and failures it drops by
# accident. The two look identical in a diff; the difference is whether anyone
# wrote it down.
package repo.policy

# ---------------------------------------------------------------------------
# rule 9 — a silenced failure says why
# ---------------------------------------------------------------------------

# A deny across both apps, which it can afford to be: 21 of the 23 silenced
# failures in the tree already carry `catch { /* why */ }`, so the convention
# exists and this only holds it. The two that did not were the two adjacent,
# identical `.catch(() => {})` calls in ProductEditForm.tsx, which is the whole
# argument for the rule — nothing distinguished the one that was considered from
# the one that was not.
deny contains v if {
	some c in input.silentCatches
	not c.documented

	v := {
		"rule": "silent_catch_is_documented",
		"file": c.file,
		"line": c.line,
		"detail": sprintf("`%s` drops the failure without saying why", [c.kind]),
		"why": concat("", [
			"This codebase drops failures deliberately in places and accidentally in others (#136), and the ",
			"two are the same three characters. Put the reason inside the braces — `catch { /* use defaults */ }` ",
			"— which is where the rest of the tree puts it and the only place that stays attached when the ",
			"code around it moves. If there is no reason, the failure needed handling.",
		]),
	}
}

# ---------------------------------------------------------------------------
# rule 12 — a log line about a record names the record
# ---------------------------------------------------------------------------

# Scoped to the modules that act on a specific order or element. `lib/bootstrap`
# and `lib/config` also log without interpolating anything, and correctly so:
# "Default branding created" has no record to name. Reporting those would make
# this warn permanent noise, which is how a warn stops being read.
record_handling_prefixes := {
	"apps/backend/src/lib/services/",
	"apps/backend/src/lib/webhook/",
	"apps/backend/src/lib/ci/",
	"apps/backend/src/lib/notification/",
}

# `messageNamesAValue`, not "any argument is not a literal": the second reading
# made every `console.error('… failed:', err)` count as naming the record, since
# an Error is a non-literal argument and it is the argument that is always there.
# The rule reported almost nothing as a result. An Error says what went wrong; it
# does not say which order it went wrong for.
#
# A deny since #482, on the same argument that made `silent_catch_is_documented`
# one: it warned on 16 call sites for as long as it existed, all 16 now name the
# record, and a warn at zero does not keep it there. The scope above is what it
# can afford to be denied on — these four directories act on a specific order,
# element or user, so there is always a record to name. A log line in them that
# genuinely has none belongs somewhere else.
deny contains v if {
	some c in input.consoleCalls
	not c.messageNamesAValue
	some prefix in record_handling_prefixes
	startswith(c.file, prefix)

	v := {
		"rule": "log_names_the_record",
		"file": c.file,
		"line": c.line,
		"detail": sprintf("console.%s(%s) carries no id", [c.method, c.message]),
		"why": concat("", [
			"#116 is about finding the log lines for one order. A message that interpolates nothing can be ",
			"grepped for but never narrowed, so it answers 'this happened' and never 'this happened to ",
			"order 4812'. Interpolate the order or element id.",
		]),
	}
}
