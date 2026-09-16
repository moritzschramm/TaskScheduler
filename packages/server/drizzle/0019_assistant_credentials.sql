-- ---------------------------------------------------------------------------
-- Somewhere to keep the key that talks to a model (spec §2.2's natural-language
-- interface).
--
-- On `users` rather than on a calendar or a tenant, because the key is an
-- account with somebody's name on it and their own bill attached. Two members
-- of one tenant using the assistant are two people spending their own money,
-- and a shared key would make one of them pay for the other.
--
-- **Not a command, and this is the one place in the application where that is
-- the right answer.** Everything that writes source state is a command (§3.2),
-- and commands are journalled into an append-only log that has UPDATE and
-- DELETE revoked from the application role. A secret written there could never
-- be taken out again — not by deleting the setting, not by rotating the key,
-- not by the audit view (§12) learning to hide it, because the row would still
-- be sitting in `commands.inverse` for undo to restore. Credentials are already
-- outside the command layer in this application: a password reaches the
-- database through Better Auth (§10.1) and nobody calls that a second write
-- path. An API key is the same kind of thing.
--
-- Stored encrypted, not hashed: the server has to be able to *use* it. The
-- ciphertext is AES-256-GCM under a key derived from `BETTER_AUTH_SECRET`,
-- which means a database dump on its own is not enough — see `secrets.ts` for
-- what that does and does not protect against.
-- ---------------------------------------------------------------------------

ALTER TABLE users
  ADD COLUMN assistant_provider text,
  ADD COLUMN assistant_model text,
  -- `iv:tag:ciphertext`, all base64url. Opaque to SQL on purpose.
  ADD COLUMN assistant_key text,
  -- The last four characters of the key in the clear, so somebody with two
  -- accounts can tell which one is configured without revealing the key.
  ADD COLUMN assistant_key_hint text;
--> statement-breakpoint

-- All four travel together or not at all: a provider with no key cannot be
-- called, and a key with no provider cannot be sent anywhere.
ALTER TABLE users
  ADD CONSTRAINT users_assistant_all_or_nothing CHECK (
    (assistant_provider IS NULL AND assistant_model IS NULL
      AND assistant_key IS NULL AND assistant_key_hint IS NULL)
    OR (assistant_provider IS NOT NULL AND assistant_model IS NOT NULL
      AND assistant_key IS NOT NULL AND assistant_key_hint IS NOT NULL)
  );
--> statement-breakpoint

ALTER TABLE users
  ADD CONSTRAINT users_assistant_provider_known
    CHECK (assistant_provider IS NULL OR assistant_provider IN ('anthropic', 'openai'));
--> statement-breakpoint

UPDATE app_meta SET value = 'm24' WHERE key = 'schema_version';
