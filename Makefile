# SAM Makefile builder — compiles TypeScript with tsc into the artifact dir.
.PHONY: build-TroubleshootingFunction

build-TroubleshootingFunction:
	npm ci
	npm run build
	cp -R dist/src/. "$(ARTIFACTS_DIR)/"
	cp package.json package-lock.json "$(ARTIFACTS_DIR)/"
	npm ci --omit=dev --prefix "$(ARTIFACTS_DIR)"
