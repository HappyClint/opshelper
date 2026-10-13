# 小信运维助手 opencode runtime image.
#
# Headless `opencode2 serve`; only the platform API accesses the container's
# private REST + SSE API on port 4096. Build:
#   docker build -t opshelper/opencode-runtime:2.0.27 deploy/opencode-runtime
FROM node:22-bookworm-slim

# git is used by opencode for some workspace operations; ripgrep speeds up
# its file search. ca-certificates for outbound provider calls. python3 + pip
# 供「用 Python 的技能」运行（如 python-docx 生成 Word）；离线环境无法临时
# pip install，故依赖在构建期预装（见下方 requirements.txt）。
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ripgrep ca-certificates dumb-init python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

# 预装技能所需的 Python 依赖。Debian 12(bookworm) 默认 PEP668「externally-
# managed」会拦截系统级 pip，容器内用 --break-system-packages 直接装进系统
# python3，使技能脚本里裸调 `python3`/`pip3` 即可命中。离线增删依赖：改
# requirements.txt 后重建镜像。
COPY requirements.txt /opt/opshelper-skill-requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r /opt/opshelper-skill-requirements.txt

# Install the opencode CLI globally. Pin the version: 离线环境依赖此版本「把
# 常用 provider(含 @ai-sdk/openai-compatible)直接编译进二进制」的行为——内网
# OpenAI 兼容模型因此无需运行时联网下载 SDK。升级前需复验该内置行为仍在。
RUN npm install -g @opencode/cli@2.0.27

# Per-user writable workspace. Managed configuration is mounted read-only;
# chat history and caches are persisted separately under /state.
RUN mkdir -p /workspace /state /opt/opshelper/config/opencode \
  && chown node:node /workspace /state
WORKDIR /workspace
USER node

ENV OPENCODE_PORT=4096

ENV HOME=/home/node \
    XDG_CONFIG_HOME=/opt/opshelper/config \
    XDG_DATA_HOME=/state/v2/data \
    XDG_CACHE_HOME=/state/v2/cache \
    XDG_STATE_HOME=/state/v2/state \
    OPENCODE_DISABLE_PROJECT_CONFIG=true \
    OPENCODE_DISABLE_EXTERNAL_SKILLS=true \
    OPENCODE_DISABLE_MODELS_FETCH=true \
    OPENCODE_DISABLE_AUTOUPDATE=true \
    OPENCODE_DISABLE_DEFAULT_PLUGINS=true

EXPOSE 4096

# The API injects independent authentication and the user's managed snapshot.
CMD ["dumb-init", "--", "opencode2", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
