-- Sign in with a security key alone, no email and no password (#241).
--
-- Two things the second-factor implementation (#197 part 2) had no need for.
--
-- 1. A challenge issued to NOBODY.
--
-- `webauthn_challenges.user_id` is its primary key, because every ceremony so
-- far ran either inside a session or after a password had already named the
-- account. A passwordless ceremony has no user at the moment the challenge is
-- issued — that is the whole point: the authenticator decides which account
-- answers. So it needs a store keyed on the challenge itself, which also gets
-- single-use from its own primary key.
--
-- Not a nullable `user_id` on the existing table: that column IS the primary key
-- and the ON CONFLICT target of `storeChallenge`, so making it nullable would
-- rewrite the "one ceremony in flight per account" rule that table exists to
-- enforce.
CREATE TABLE "webauthn_login_challenges" (
	"challenge" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- 2. Whether a credential can answer a passwordless ceremony at all.
--
-- Registration asks for `residentKey: 'preferred'`, and the authenticator
-- decides. A modern passkey stores a discoverable credential and can be offered
-- with no `allowCredentials`; an older hardware key stores a non-discoverable
-- one and simply will not appear. Both remain perfectly good second factors.
--
-- The authenticator reports which it made through the `credProps` extension, and
-- nothing recorded it before — so the answer is stored when it is learned. It
-- cannot be derived from the credential afterwards, and it cannot change without
-- re-registering the key.
--
-- DEFAULT false is the honest backfill rather than a guess: credentials
-- registered before this migration were never asked for `credProps`, so what
-- they are is genuinely unknown. Claiming they are discoverable would offer the
-- user a passwordless button their key silently fails to answer. A credential
-- earns the flag the first time it does answer one.
ALTER TABLE "webauthn_credentials" ADD COLUMN "discoverable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- For sweeping challenges that were never claimed; the DELETE is what makes a
-- claimed one single-use.
CREATE INDEX "webauthn_login_challenges_expires_idx" ON "webauthn_login_challenges" USING btree ("expires_at");
