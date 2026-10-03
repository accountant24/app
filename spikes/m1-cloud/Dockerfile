# The books sandbox: git, hledger (pinned to the desktop's version) and the Sandbox SDK helper.
# Everything runs as root: the container is temporary and holds nothing but one set of books, and the checks
# that matter run outside it, after each push.
FROM --platform=linux/amd64 debian:trixie-slim

ARG HLEDGER_VERSION=1.52.4

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git poppler-utils \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://github.com/simonmichael/hledger/releases/download/${HLEDGER_VERSION}/hledger-linux-x64.tar.gz" \
    | tar -xz -C /usr/local/bin hledger \
  && chmod 755 /usr/local/bin/hledger \
  && hledger --version

# The tag must match the installed @cloudflare/sandbox version.
COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

RUN mkdir /books

# Git trusts the CA that signs intercepted HTTPS (the Worker adds the Artifacts token on the way out).
ENV GIT_SSL_CAINFO=/etc/cloudflare/certs/cloudflare-containers-ca.crt

WORKDIR /books
CMD ["sleep", "infinity"]
