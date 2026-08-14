# OxShare CRM API — production image.
#
# bookworm-slim, NOT alpine. uWebSockets.js ships prebuilt binaries for glibc
# only (uws_linux_x64_{115,127,131,137}.node — 127 is Node 22's ABI) and has no
# musl variant. On alpine the require() throws, and realtime-io.adapter.ts
# catches it and falls back to the slower Node engine with nothing but a
# logger.warn — so the image would "work" while silently losing the capability
# it was built for. The deploy asserts the binary loads for the same reason.

# The FULL bookworm image for building, -slim only for the runtime below.
#
# uWebSockets.js is a git dependency, so the install needs `git` and
# `ca-certificates`. node:22-bookworm already has both; node:22-bookworm-slim
# does not, and `apt-get install` here made every build — including CI, including
# a production hotfix — depend on a Debian mirror answering. It failed exactly
# that way on the first attempt. This layer cannot fail, because there is no
# layer.
#
# Nothing from this stage ships except node_modules and dist, so its size is
# irrelevant. Both images are Debian 12, so the glibc that argon2's and uWS's
# prebuilt .node binaries link against is identical on both sides of the copy.
#
# Deliberately NOT adding python3/make/g++: argon2 and uWS both resolve prebuilt
# binaries, and a toolchain would be build cache spent on nothing.
FROM node:22-bookworm AS builder
WORKDIR /app

COPY package.json package-lock.json ./

# npm 11, PINNED — the npm that interprets the lockfile is part of the build.
#
# The lockfile is written by npm 11 (the version on the machines that maintain
# it). node:22 images bundle npm 10.9, whose ideal-tree builder mishandles a
# lockfile when package.json carries `overrides`: it re-resolves nested ranges
# against the registry's LATEST instead of honouring the locked version. The
# day esbuild published 0.28.2, `npm ci` here started refusing the lockfile
# ("Missing: esbuild@0.28.2 from lock file") with tsx's esbuild locked at
# 0.28.1 — no commit involved; the desync appears and reappears on every
# upstream patch release. npm 11 honours the lock. CI pins the same version
# for the same reason.
#
# "prepare": "husky" runs on npm ci and there is no .git here to install hooks
# into. Deleting the script is deterministic; npm ci reconciles DEPENDENCIES
# against the lockfile, not scripts, so this does not desync it. Install scripts
# stay enabled on purpose — argon2's node-gyp-build needs to run.
RUN npm install -g npm@11 \
 && npm pkg delete scripts.prepare \
 && npm ci --no-audit --no-fund

COPY . .

# prune emits only removals, and npm skips lifecycle scripts on removals — so
# the "prepare" that COPY just restored is never invoked. This is what lets the
# runtime image carry a production-only tree without a second npm ci.
RUN npm run build \
 && npm prune --omit=dev


FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/scripts/migrate.mjs /app/scripts/bootstrap-admin.mjs ./scripts/

# nest build does not copy .sql files, so the migrator needs these explicitly:
# 67 migrations plus meta/_journal.json, which is the authoritative order.
# drizzle-orm's migrator resolves this folder itself (see scripts/migrate.mjs);
# the path here and the path there have to agree.
COPY --from=builder /app/src/database/migrations ./src/database/migrations

# main.ts's FIRST statement is mkdirSync(cwd/uploads/kyc) — unconditional, ahead
# of Nest, and run even under STORAGE_DRIVER=r2 (a legacy disk driver still reads
# from here for documents predating the R2 move). Docker would otherwise create
# the volume mountpoint as root:root, uid 1000 would get EACCES, and because that
# throw happens inside `void bootstrap()` it surfaces as an unhandled rejection —
# exit 1, restart, forever, with the healthcheck never reached.
RUN install -d -o node -g node /app/uploads/kyc \
 && chown node:node /app

USER node

# 3001 API, 3003 realtime — uWS owns a second, independent TCP listener.
EXPOSE 3001 3003

# Liveness, not readiness. /health is unversioned and checks nothing by design;
# /health/ready costs a BILLED R2 round trip and 503s on a transient DB blip,
# which would make a healthcheck restart the container over someone else's
# outage. 127.0.0.1 rather than localhost sidesteps undici's IPv6-first ordering.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main"]
