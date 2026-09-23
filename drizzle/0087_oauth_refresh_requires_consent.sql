-- #851: a refresh token may only be minted for a user who holds a consent for
-- that client. Disconnect (`disconnectApp`, src/server/oauth-grants-logic.ts)
-- deletes the consent; this makes every later mint fail, whichever path it
-- comes down: an authorization code issued before the disconnect and redeemed
-- after it (the provider never re-checks consent at redemption), or a refresh
-- rotation that revoked its old row before the disconnect and inserts the
-- replacement after it (the provider does those in two separate statements).
--
-- `FOR SHARE` on the consent row is the half that closes the race rather than
-- narrowing it. `disconnectApp` takes `FOR UPDATE` on the same row first, so a
-- mint that arrives while a disconnect is open waits for it, then finds the
-- row gone and is refused. A mint that got its share lock first commits before
-- the disconnect's lock is granted, so the disconnect's delete sees its row.
--
-- A client registered with `skip_consent` never writes a consent row, so it is
-- exempt. No client here is registered that way.
CREATE OR REPLACE FUNCTION oauth_refresh_token_requires_consent() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM oauth_client c
		WHERE c.client_id = NEW.client_id AND c.skip_consent IS TRUE
	) THEN
		RETURN NEW;
	END IF;
	PERFORM 1 FROM oauth_consent
		WHERE user_id = NEW.user_id AND client_id = NEW.client_id
		FOR SHARE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'oauth_refresh_token refused: user % holds no oauth_consent for client %',
			NEW.user_id, NEW.client_id
			USING ERRCODE = 'insufficient_privilege';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS oauth_refresh_token_requires_consent ON oauth_refresh_token;--> statement-breakpoint
CREATE TRIGGER oauth_refresh_token_requires_consent
	BEFORE INSERT ON oauth_refresh_token
	FOR EACH ROW EXECUTE FUNCTION oauth_refresh_token_requires_consent();
