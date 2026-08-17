# PG 18 client, matching the Railway Postgres server (ghcr.io/railwayapp-templates/postgres-ssl:18).
# pg_dump refuses outright to dump a server NEWER than itself, so this tag must
# track the database's major version — a 17 client cannot read an 18.4 server.
FROM postgres:18-alpine

# The postgres image's default entrypoint initialises a data directory and starts
# a server. This service only ever runs pg_dump against a remote host, so clear it.
ENTRYPOINT []

COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh

CMD ["/bin/sh", "/usr/local/bin/backup.sh"]
