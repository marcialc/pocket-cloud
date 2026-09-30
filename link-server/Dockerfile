# The link server image: linkd (two GBAs on an emulated link cable).
# Cloudflare Containers run linux/amd64, so build for that platform:
#   docker build --platform linux/amd64 -t pocket-cloud-link link-server
FROM debian:trixie-slim AS build
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		build-essential cmake git ca-certificates pkg-config \
		zlib1g-dev libpng-dev clang llvm \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
# Builds mGBA and linkd and fails the image if the link self-test fails.
RUN WORK_DIR=/work ./build.sh

FROM debian:trixie-slim
RUN apt-get update \
	&& apt-get install -y --no-install-recommends zlib1g libpng16-16t64 \
	&& rm -rf /var/lib/apt/lists/*
COPY --from=build /work/linkd/linkd /usr/local/bin/linkd
# The test page; the real client will live in the Pocket Cloud app.
COPY web /usr/share/linkd/web
EXPOSE 8080
ENTRYPOINT ["linkd"]
# Session mode: the link room's Durable Object sends the games over HTTP.
CMD ["--listen", "8080", "--web", "/usr/share/linkd/web"]
