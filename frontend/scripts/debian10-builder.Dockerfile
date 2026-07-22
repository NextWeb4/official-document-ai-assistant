FROM --platform=$TARGETPLATFORM debian:10.10-slim

ARG TARGETARCH
ARG TARGETVARIANT
ARG NODE_VERSION=20.19.5
ARG PYTHON_VERSION=3.12.7

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/opt/node/bin:/opt/python/bin:${PATH}"
ENV LD_LIBRARY_PATH="/opt/python/lib:${LD_LIBRARY_PATH}"

RUN set -eux; \
    sed -i \
      -e 's/deb.debian.org/archive.debian.org/g' \
      -e 's/security.debian.org/archive.debian.org/g' \
      -e '/buster-updates/d' \
      /etc/apt/sources.list; \
    printf 'Acquire::Check-Valid-Until "false";\n' > /etc/apt/apt.conf.d/99archive-valid-until; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      dpkg-dev \
      fakeroot \
      file \
      gcc \
      g++ \
      git \
      make \
      perl \
      rsync \
      xz-utils \
      zlib1g-dev \
      libbz2-dev \
      libffi-dev \
      liblzma-dev \
      libreadline-dev \
      libsqlite3-dev \
      libssl-dev \
      uuid-dev; \
    rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    case "${TARGETARCH}${TARGETVARIANT}" in \
      amd64) node_arch="x64" ;; \
      arm64) node_arch="arm64" ;; \
      armv7) node_arch="armv7l" ;; \
      *) echo "Unsupported Node.js target: ${TARGETARCH}${TARGETVARIANT}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" -o /tmp/node.tar.xz; \
    mkdir -p /opt/node; \
    tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1; \
    rm /tmp/node.tar.xz; \
    node --version; \
    npm --version

RUN set -eux; \
    curl -fsSL "https://www.python.org/ftp/python/${PYTHON_VERSION}/Python-${PYTHON_VERSION}.tar.xz" -o /tmp/python.tar.xz; \
    mkdir -p /tmp/python-src; \
    tar -xJf /tmp/python.tar.xz -C /tmp/python-src --strip-components=1; \
    cd /tmp/python-src; \
    ./configure --prefix=/opt/python --enable-shared --with-ensurepip=install; \
    make -j"$(nproc)"; \
    make install; \
    /opt/python/bin/python3 -m pip install --no-cache-dir --upgrade pip; \
    cd /; \
    rm -rf /tmp/python-src /tmp/python.tar.xz; \
    python3 --version; \
    pip3 --version

WORKDIR /build/work/frontend
