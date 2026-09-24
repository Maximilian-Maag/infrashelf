# Rules about the schema, the migrations, and the test setup that has to agree
# with both of them.
package repo.policy

# ---------------------------------------------------------------------------
# rule 2 — no secret column in a hand-written select() projection
# ---------------------------------------------------------------------------

# Reads of a credential column that are deliberate, keyed by file and column so
# that a *second* secret read in an already-listed file is still reported.
#
# A bare `.select()` is not checked at all: it is unavoidably a whole-row read,
# there are dozens, and flagging them would bury the signal. What #144 actually
# was is a hand-written projection that reached one column further than the
# caller needed — which is what a named projection makes visible.
intentional_secret_reads := {
	"apps/backend/src/lib/db/queries.ts accessToken": "the CI source's API token, sent as the PRIVATE-TOKEN header to GitLab; never returned to a portal client",
	"apps/backend/src/lib/bootstrap/index.ts accessToken": "the one-time backfill that encrypts CI source tokens written before #111; it reads each plaintext value only to write the envelope back over it, logs the COUNT and never the value, and the rows never leave the function",
	"apps/backend/src/lib/ci/webhooks.ts webhookToken": "the pipeline trigger token, sent to the CI provider to start a pipeline",
	"apps/backend/src/lib/services/auth.ts passwordHash": "bcrypt.compare for a password change; the hash is compared and discarded",
	"apps/backend/src/lib/services/twoFactor.ts passwordHash": "bcrypt.compare before enrolling or replacing a factor (#36 invariant 2: a password alone may not swap the factor out); TwoFactorAccount is service-internal and no route returns it",
	"apps/backend/src/lib/services/admin/environments.ts callbackSecret": "the root-gated reveal endpoint — the operator has to be able to read the secret they must paste into the CI system",
	"apps/backend/src/app/api/webhooks/github/workflow/route.ts callbackSecret": "verifies the HMAC of an incoming callback against the environment's own secret",
	"apps/backend/src/app/api/webhooks/bitbucket/pipeline/route.ts callbackSecret": "verifies the HMAC of an incoming callback against the environment's own secret",
	"apps/backend/src/lib/auth/sessions.ts tokenHash": "validateSession compares the stored SHA-256 against the hash of the presented token; the row never leaves the function",
	"apps/backend/src/lib/services/admin/integrations.ts credential": "probeIntegrationById and resolveIntegration decrypt it to build the outbound Authorization header; no route returns a ResolvedIntegration, and the list/get paths project the column away",
	"apps/backend/src/lib/services/twoFactor.ts secret": "requiresSecondFactor reads it only through isConfirmed — `secret IS NOT NULL AND confirmed_at IS NOT NULL` is what \"2FA is on\" means — and returns a boolean",
	"apps/backend/src/lib/crypto/appSecrets.ts smtpPass": "the module that owns this column since #556: it reads the value to decrypt it for nodemailer, and in the boot backfill to write an envelope back over it in place; it is never returned to a caller, and the boot log carries a count and no value",
	"apps/backend/src/lib/crypto/appSecrets.ts aiApiKey": "the module that owns this column since #556: it reads the value to decrypt it for the AI client, and in the boot backfill to write an envelope back over it in place; it is never returned to a caller, and the boot log carries a count and no value",
}

deny contains v if {
	some s in input.selects
	some column in s.secretColumns
	not intentional_secret_reads[sprintf("%s %s", [s.file, column])]

	v := {
		"rule": "no_secret_column_in_select",
		"file": s.file,
		"line": s.line,
		"detail": sprintf("projection names `%s`, which holds a credential", [column]),
		"why": concat("", [
			"A column added to a projection travels wherever that projection's rows go, and #144 was ",
			"exactly that: provider tokens reached error bodies, the audit log and admin reads because ",
			"a select grew one field. Drop the column, or add `<file> <column>` to `intentional_secret_reads` ",
			"in policy/database.rego with the reason it never leaves the process.",
		]),
	}
}

# ---------------------------------------------------------------------------
# rule 3 — every table is truncated between tests
# ---------------------------------------------------------------------------

# This rule used to have two halves, and the other one is gone with #147.
#
# It checked that every table had a CREATE TABLE in src/test/setup.ts, because
# that file was a hand-maintained third copy of the schema and a table missing
# from it simply did not exist under test. The copy is gone: the suite now runs
# the real migrations, so there is nothing left to fall behind and nothing left
# to check.
#
# What remains is the half that was never about the copy. A table declared in
# schema.ts and absent from TABLES is never emptied between tests, so rows leak
# into the next one — a suite that passes alone and fails in a full run, or the
# reverse, which is the most expensive kind of failure to chase. A deny now,
# which is what this rule's own comment said it should become once #147 landed.
deny contains v if {
	some table in input.tables
	not table.inTestTables

	v := {
		"rule": "table_in_test_setup",
		"file": input.testSetupFile,
		"line": 0,
		"detail": sprintf("`schema.%s` is not in the TABLES list, so it is never truncated between tests", [table.export]),
		"why": concat("", [
			"Rows left behind leak into the next test. The symptom is a test that passes on its own and ",
			"fails in a full run, or vice versa. Add it to TABLES in src/test/setup.ts; a singleton row ",
			"the app needs is put back by the seed in `beforeEach` alongside the truncate.",
		]),
	}
}

# ---------------------------------------------------------------------------
# rule 4 — migrations and the journal agree
# ---------------------------------------------------------------------------

journal_tags := {entry.tag | some entry in input.migrations.journal}

migration_tags := {file.tag | some file in input.migrations.files}

deny contains v if {
	some file in input.migrations.files
	not journal_tags[file.tag]

	v := {
		"rule": "migration_matches_journal",
		"file": file.file,
		"line": 0,
		"detail": sprintf("no entry for %q in %s", [file.tag, input.migrations.journalFile]),
		"why": concat("", [
			"drizzle-kit applies what the journal lists, not what the directory holds. A .sql file with no ",
			"entry is never run: the app boots against a database missing the change, and fails at the first ",
			"query that needs it.",
		]),
	}
}

deny contains v if {
	some entry in input.migrations.journal
	not migration_tags[entry.tag]

	v := {
		"rule": "migration_matches_journal",
		"file": input.migrations.journalFile,
		"line": 0,
		"detail": sprintf("entry %d names %q, and there is no such .sql file", [entry.idx, entry.tag]),
		"why": "drizzle-kit stops at the first entry whose file it cannot read, so every later migration is skipped too.",
	}
}

deny contains v if {
	some file in input.migrations.files
	some entry in input.migrations.journal
	entry.tag == file.tag
	entry.idx != file.index

	v := {
		"rule": "migration_matches_journal",
		"file": file.file,
		"line": 0,
		"detail": sprintf("filename says %04d, journal entry says idx %d", [file.index, entry.idx]),
		"why": "The journal's idx decides the order migrations run in; a filename that disagrees makes the directory listing lie about it.",
	}
}

# An idx or a tag that appears twice. The gap rule below cannot see this — it only
# asks whether each index has a predecessor, and two entries numbered 22 both have
# a 21 — so an ambiguous order passed the whole of rule 4.
#
# Ambiguous is the charitable word. drizzle-kit applies entries in journal order
# and records the one it applied; a repeated idx means the directory listing, the
# journal and the applied history disagree about which migration is which.
deny contains v if {
	some entry in input.migrations.journal
	count([e | some e in input.migrations.journal; e.idx == entry.idx]) > 1

	v := {
		"rule": "migration_matches_journal",
		"file": input.migrations.journalFile,
		"line": 0,
		"detail": sprintf("idx %d is used by more than one entry", [entry.idx]),
		"why": "Two entries with the same index leave the order they run in undefined, and the filename that says 0022 no longer identifies one migration.",
	}
}

deny contains v if {
	some entry in input.migrations.journal
	count([e | some e in input.migrations.journal; e.tag == entry.tag]) > 1

	v := {
		"rule": "migration_matches_journal",
		"file": input.migrations.journalFile,
		"line": 0,
		"detail": sprintf("tag %q is used by more than one entry", [entry.tag]),
		"why": "One .sql file listed twice is applied twice, and the second run hits a table that already exists.",
	}
}

# ---------------------------------------------------------------------------
# rule 4b — the journal's `when` strictly increases
# ---------------------------------------------------------------------------

# The one field drizzle-kit actually compares. `pg-core/dialect.js`:
#
#     if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis)
#
# A strict `<` against the `when` of the last migration applied. So two entries
# sharing a `when` are not untidiness: the first raises the watermark to that
# value, and every later entry holding it fails the comparison and is SKIPPED,
# with no error and no output.
#
# That is not hypothetical. Five entries on dev (0020, 0022, 0023, 0024, 0025)
# carry 1787702400000 after several branches were rebased in parallel, each having
# computed `when` against its own base. On a fresh database four migrations never
# run — including 0025, the callback-secret rotation, so a security fix is present
# in the source and absent from the database. #194 renumbers them.
#
# A deny, now that #194 has renumbered the five colliding entries and the journal
# this evaluates is strictly increasing. It was a warn only for as long as the
# collision was in the tree — a gate that reports the fault it cannot fail on is
# how the fault stays.
deny contains v if {
	some i, entry in input.migrations.journal
	i > 0
	previous := input.migrations.journal[i - 1]
	entry.when <= previous.when

	v := {
		"rule": "migration_when_increases",
		"file": input.migrations.journalFile,
		"line": 0,
		"detail": sprintf(
			"%s has when=%d, which does not come after %s (when=%d), so drizzle-kit skips it",
			[entry.tag, entry.when, previous.tag, previous.when],
		),
		"why": concat("", [
			"drizzle-kit decides whether to apply a migration with a strict `<` against the `when` of the ",
			"last one it applied, so an entry whose `when` does not increase is skipped silently — no error, ",
			"no output, and a database missing the change while the source contains it. #194 is the four ",
			"migrations this already hid, one of them a security fix. Regenerate the migration, or edit the ",
			"`when` so it comes after its predecessor's.",
		]),
	}
}

# Gaps are a warn and will stay one. There are three on dev (17, 18, 21), left by
# migrations that were generated and deleted before release. Closing them means
# renumbering migrations that have already been applied to real databases, which
# is a worse problem than the one it solves. What the gap is still worth saying
# is that `pnpm db:generate` produced something that was thrown away — the
# opening move of #141.
warn contains v if {
	some entry in input.migrations.journal
	entry.idx > 0
	previous := entry.idx - 1
	not journal_idx[previous]

	v := {
		"rule": "migration_numbering_is_contiguous",
		"file": input.migrations.journalFile,
		"line": 0,
		"detail": sprintf("idx %d follows a gap at %d", [entry.idx, previous]),
		"why": concat("", [
			"A gap means a migration was generated and then removed. Harmless once released — renumbering ",
			"applied migrations would be worse — but it is how #141 starts, so it is worth seeing.",
		]),
	}
}

journal_idx := {entry.idx | some entry in input.migrations.journal}
