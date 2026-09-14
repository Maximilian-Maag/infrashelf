.PHONY: help install tools mise dev dev-down run run-backend run-frontend build lint type-check policy policy-facts policy-install-opa test-db test-db-prune test test-e2e docker-build-backend docker-build-frontend docker-build db-push db-studio db-seed db-seed-demo handbook handbook-clean diagrams diagrams-install diagrams-png diagrams-pdf diagrams-clean clean

# The toolchain comes from mise (see mise.toml), which pins the exact Node and
# pnpm this repository is built with. `make install` bootstraps it, so a new
# machine needs nothing installed beforehand.
#
# Resolved rather than assumed: mise installs itself to ~/.local/bin, which is not
# on every distro's default PATH, and a login shell that has not been restarted
# since will not see it. Looking in both places means `make install` works in the
# same terminal that installed it.
MISE := $(shell command -v mise 2>/dev/null || (test -x $(HOME)/.local/bin/mise && echo $(HOME)/.local/bin/mise))

# Every tool runs THROUGH mise when it is available, so the versions in mise.toml
# are the ones that actually execute — not whatever a globally installed pnpm
# happens to be. Without mise this falls back to the previous behaviour: a
# standalone pnpm on PATH.
ifneq ($(MISE),)
  RUN := $(MISE) exec --
else
  RUN :=
  # pnpm installed via standalone script — add its bin dir so make can find it
  PNPM_HOME ?= $(HOME)/.local/share/pnpm
  export PATH := $(PNPM_HOME)/bin:$(PATH)
endif
PNPM := $(RUN) pnpm

help:
	@echo "Usage: make <target>"
	@echo ""
	@echo "  install               install the toolchain (mise) and all workspace dependencies"
	@echo "  tools                 install just the pinned Node and pnpm from mise.toml"
	@echo "  dev                   start infra containers (postgres, mailpit, wiremock, structurizr)"
	@echo "  dev-down              stop infra containers"
	@echo "  run                   start backend and frontend dev servers together (requires: make dev)"
	@echo "  run-backend           start backend dev server on :3001"
	@echo "  run-frontend          start frontend dev server on :3000"
	@echo "  build                 build all workspace packages"
	@echo "  lint                  lint all apps"
	@echo "  type-check            TypeScript type-check all apps"
	@echo "  policy                run the OPA codebase-invariant gate (same as CI)"
	@echo "  policy-facts          print the JSON the policies are evaluated against"
	@echo "  policy-install-opa    fetch the pinned opa binary into .opa/"
	@echo "  test-db               create the e2e database in the running Postgres"
	@echo "  test-db-prune         drop the per-directory backend test databases"
	@echo "  test                  run unit and integration tests"
	@echo "  test-e2e              run end-to-end Playwright tests (requires live stack)"
	@echo "  docker-build-backend  build backend Docker image"
	@echo "  docker-build-frontend build frontend Docker image"
	@echo "  docker-build          build both Docker images"
	@echo "  db-push               push Drizzle schema to the database"
	@echo "  db-studio             open Drizzle Studio"
	@echo "  db-seed               seed the database with the initial admin user"
	@echo "  db-seed-demo          add a small demo catalogue (refused when NODE_ENV=production)"
	@echo "  handbook              compile technical handbook to PDF (not committed — see README)"
	@echo "  handbook-clean        remove LaTeX auxiliary files"
	@echo "  clean                 remove build artifacts"

# Everything a developer needs, from a clean machine: the toolchain first, then
# the workspace. Depends on `tools` rather than repeating it, so `make install`
# stays the single answer to "how do I set this up".
install: tools
	$(PNPM) install

# The pinned Node and pnpm from mise.toml.
#
# `mise install` is idempotent and fast once the versions are present, so this
# costs a second on every `make install` and removes a whole class of "which Node
# are you on" from bug reports.
tools: mise
	@$(MISE) trust --quiet 2>/dev/null || $(MISE) trust
	$(MISE) install
	@echo "toolchain: $$($(MISE) exec -- node -v), pnpm $$($(MISE) exec -- pnpm -v)"

# Install mise itself if it is not already there.
#
# Guarded, so this is a no-op on a machine that has it — and it deliberately does
# NOT edit anybody's shell profile. Activating mise in an interactive shell is the
# developer's choice; everything in this Makefile goes through `mise exec`, so the
# build does not need it and will not silently depend on it.
mise:
ifeq ($(MISE),)
	@echo "mise not found — installing to ~/.local/bin"
	@curl -fsSL https://mise.run | sh
	@echo ""
	@echo "  mise installed. To use the pinned tools in your own shell, add:"
	@echo "      eval \"\$$($(HOME)/.local/bin/mise activate bash)\""
	@echo "  to ~/.bashrc. The Makefile does not need it."
	@echo ""
	@$(MAKE) --no-print-directory tools MISE=$(HOME)/.local/bin/mise
else
	@echo "mise: $(MISE) ($$($(MISE) --version))"
endif

dev:
	docker compose -f infra/docker-compose.dev.yml up -d --wait

dev-down:
	docker compose -f infra/docker-compose.dev.yml down

run:
	$(PNPM) --parallel --filter backend --filter frontend dev

run-backend:
	$(PNPM) --filter backend dev

run-frontend:
	$(PNPM) --filter frontend dev

build:
	$(PNPM) build

lint:
	$(PNPM) lint

type-check:
	$(PNPM) --parallel --filter './apps/*' exec tsc --noEmit

# The codebase-invariant gate (issue #149): rules that span files, which is what
# ESLint cannot see. Runs `opa test` on the policies first — a policy with a bug
# is worse than no policy — then evaluates them against the tree. Deny fails,
# warn reports. This is the same command the `policy` job in CI runs.
# tsx transpiles without checking, so a typo in the extractor would silently
# produce a fact the policies never match. The gate checks its own code first.
policy:
	@node_modules/.bin/tsc -p scripts/tsconfig.json
	@node_modules/.bin/tsx scripts/policy-check.ts

policy-facts:
	@node_modules/.bin/tsx scripts/policy-facts.ts

policy-install-opa:
	@node_modules/.bin/tsx scripts/opa.ts

# The backend suite creates its own database on first run — one per working
# directory, so a mutation run in .stryker-tmp/sandbox-* cannot truncate the
# tables of an ordinary run (see apps/backend/src/test/database.ts). This target
# is only needed for the e2e database, which the Playwright stack expects to exist.
# Idempotent, so it is safe to re-run.
test-db:
	@for db in infrashelf_test infrashelf_e2e; do \
	  docker exec isf-postgres psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$$db'" | grep -q 1 \
	    && echo "  exists  $$db" \
	    || { docker exec isf-postgres createdb -U postgres "$$db" && echo "  created $$db"; }; \
	done

# Drops the per-directory databases the backend suite created. They are cheap to
# recreate (the schema is pushed on first run) and easy to forget about.
test-db-prune:
	@dbs="$$(docker exec isf-postgres psql -U postgres -tAc \
	  "SELECT datname FROM pg_database WHERE datname LIKE 'infrashelf_test\_%'")" \
	  || { echo "  could not list databases — is the compose stack up?" >&2; exit 1; }; \
	for db in $$dbs; do \
	  [ -n "$$db" ] || continue; \
	  docker exec isf-postgres dropdb -U postgres --if-exists "$$db" && echo "  dropped $$db"; \
	done

test:
	$(PNPM) --filter backend test
	$(PNPM) --filter frontend test
	$(PNPM) test:scripts

test-e2e:
	$(PNPM) test:e2e

docker-build-backend:
	docker build -t infrashelf-backend:latest -f apps/backend/Dockerfile .

docker-build-frontend:
	docker build -t infrashelf-frontend:latest -f apps/frontend/Dockerfile .

docker-build: docker-build-backend docker-build-frontend

db-push:
	$(PNPM) db:push

db-studio:
	$(PNPM) --filter backend db:studio

db-seed-demo:
	cd apps/backend && ../../node_modules/.bin/tsx --env-file=.env --tsconfig tsconfig.json src/seed-demo.ts

db-seed:
	cd apps/backend && ../../node_modules/.bin/tsx --env-file=.env --tsconfig tsconfig.json src/seed.ts

diagrams-install:
	@node_modules/.bin/tsx scripts/diagramTools.ts

# The C4 pictures, from docs/architecture/workspace.dsl — the model is the source
# of truth and the handbook includes what this writes. Both formats by default:
# --jpeg writes PNG (line art, so JPEG's block artefacts would land on the glyph
# edges), --pdf writes ONE vector PDF of the C4 diagrams in reading order.
diagrams: diagrams-install
	@node_modules/.bin/tsx scripts/diagrams.ts --jpeg --pdf

diagrams-png: diagrams-install
	@node_modules/.bin/tsx scripts/diagrams.ts --jpeg

diagrams-pdf: diagrams-install
	@node_modules/.bin/tsx scripts/diagrams.ts --pdf

diagrams-clean:
	@rm -rf docs/architecture/diagrams .diagrams/puml
	@echo "Removed generated diagrams (the pinned jars in .diagrams/ are kept)"

handbook: diagrams-png
	@command -v pdflatex >/dev/null 2>&1 || \
	  { echo "ERROR: pdflatex not found. Install TeX Live: sudo pacman -S texlive-most"; exit 1; }
	@echo "Compiling handbook (pass 1/2)..."
	cd docs && pdflatex -interaction=nonstopmode handbook.tex > /dev/null
	@echo "Compiling handbook (pass 2/2 — ToC + references)..."
	cd docs && pdflatex -interaction=nonstopmode handbook.tex > /dev/null
	@echo "Done: docs/handbook.pdf (gitignored — see README)"

handbook-clean:
	cd docs && rm -f handbook.aux handbook.log handbook.out handbook.toc \
	               handbook.lof handbook.lot handbook.lol handbook.fls handbook.fdb_latexmk \
	               handbook.synctex.gz

clean:
	rm -rf apps/backend/.next apps/frontend/.next packages/types/dist
