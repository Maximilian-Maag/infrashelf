package repo.policy_test

import data.repo.policy

# --- rule 9 ----------------------------------------------------------------

silent(file, documented) := {"silentCatches": [{
	"file": file,
	"line": 254,
	"kind": ".catch(() => {})",
	"documented": documented,
}]}

test_undocumented_backend_catch_is_denied if {
	facts := silent("apps/backend/src/lib/services/orders.ts", false)
	denied := policy.deny with input as facts
	some v in denied
	v.rule == "silent_catch_is_documented"
	v.line == 254
	contains(v.why, "#136")

	# The message says where to put the reason, not just that one is missing.
	contains(v.why, "inside the braces")
}

test_undocumented_frontend_catch_is_denied_too if {
	facts := silent("apps/frontend/src/app/login/page.tsx", false)
	denied := policy.deny with input as facts
	some v in denied
	v.rule == "silent_catch_is_documented"
}

test_a_documented_catch_passes_on_either_side if {
	backend := silent("apps/backend/src/lib/services/orders.ts", true)
	frontend := silent("apps/frontend/src/app/login/page.tsx", true)
	backend_denied := policy.deny with input as backend
	frontend_denied := policy.deny with input as frontend
	count(backend_denied) == 0
	count(frontend_denied) == 0
}

# --- rule 12 ---------------------------------------------------------------

# `messageNamesAValue` is about the *message* argument only. The rule used to ask
# whether any argument was non-literal, which every `console.error('…', err)` in
# the tree satisfied.
logs(file, messageNamesAValue) := logs_saying(file, "'[orders] Could not start element'", messageNamesAValue)

logs_saying(file, message, messageNamesAValue) := {"consoleCalls": [{
	"file": file,
	"line": 60,
	"method": "error",
	"message": message,
	"messageNamesAValue": messageNamesAValue,
}]}

# A deny since #482: every call site in the four directories names its record,
# and a warn at zero does not keep it there.
test_a_log_about_an_order_that_names_no_id_is_denied if {
	facts := logs("apps/backend/src/lib/services/orders.ts", false)
	denied := policy.deny with input as facts
	some v in denied
	v.rule == "log_names_the_record"
	contains(v.why, "#116")
}

test_a_log_that_interpolates_an_id_passes if {
	facts := logs("apps/backend/src/lib/services/orders.ts", true)
	denied := policy.deny with input as facts
	count(denied) == 0
}

# "Default branding created" has no record to name, and denying it would make the
# rule impossible to satisfy rather than merely noisy.
test_bootstrap_logs_are_out_of_scope if {
	facts := logs("apps/backend/src/lib/bootstrap/index.ts", false)
	denied := policy.deny with input as facts
	count(denied) == 0
}

test_webhook_and_ci_modules_are_in_scope if {
	webhook := logs("apps/backend/src/lib/webhook/handler.ts", false)
	ci := logs("apps/backend/src/lib/ci/gitlab.ts", false)
	webhook_denied := policy.deny with input as webhook
	ci_denied := policy.deny with input as ci
	count(webhook_denied) == 1
	count(ci_denied) == 1
}

# The shape the old reading let through, and the reason the fact is about the
# message and not the argument list: an Error is a non-literal argument and it is
# the one that is always there, so "any non-literal argument" made this call
# count as naming the record. It says what went wrong, not which order it went
# wrong for.
test_a_fixed_message_with_an_error_argument_is_still_denied if {
	facts := logs_saying(
		"apps/backend/src/lib/notification/email.ts",
		"'[notification] Failed to send email:'",
		false,
	)
	denied := policy.deny with input as facts
	some v in denied
	v.rule == "log_names_the_record"
	contains(v.detail, "carries no id")
}
