# Every target is safe to re-run. `make` alone checks the adapter and installs it.
CACHE ?= $(HOME)/.cache/dsh-pstack/upstream
PROFILE ?= $(or $(DSH_PROFILE),web)
UPSTREAM ?= https://github.com/cursor/plugins

.PHONY: all check check-preset install preset baseline sync clean

all: check install

# A. adapter vocabulary + model families + skill integrity
check:
	node adapter/check.mjs

# C. the shipped standard preset moved under us
check-preset:
	node preset/check.mjs

install:
	./install.sh

# Regenerate preset/cordis.patch.yml from vendor/baseline/standard.plugins.yml
preset:
	node preset/build.mjs

# Refresh that baseline from the live profile after a DSH upgrade
baseline:
	node preset/build.mjs --refresh

# Vendor a fresh upstream snapshot, then re-check the adapter against it
sync:
	@test -d "$(CACHE)/.git" || git clone --depth 1 --filter=blob:none --sparse $(UPSTREAM) "$(CACHE)"
	git -C "$(CACHE)" sparse-checkout set pstack scripts
	git -C "$(CACHE)" fetch --depth 1 origin main
	git -C "$(CACHE)" checkout --detach FETCH_HEAD
	rm -rf vendor/pstack && mkdir -p vendor/pstack
	cp -a "$(CACHE)/pstack/." vendor/pstack/
	rm -rf vendor/pstack/.DS_Store vendor/pstack/.cursor-plugin
	cp "$(CACHE)/scripts/generate-pstack-harness-trees.mjs" vendor/upstream/
	@{ \
	  printf 'repo: cursor/plugins\n'; \
	  printf 'commit: %s\n' "$$(git -C "$(CACHE)" rev-parse HEAD)"; \
	  printf 'tag: none\n'; \
	  printf 'plugin_version: %s\n' "$$(node -p "require('./vendor/pstack/plugin.json').version")"; \
	  printf 'path: pstack\n'; \
	  printf 'synced_at: %s\n' "$$(date +%F)"; \
	} > vendor/UPSTREAM
	@cat vendor/UPSTREAM
	$(MAKE) check

clean:
	rm -rf .cache-composed.yml
