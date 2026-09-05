#!/usr/bin/env bash
# SWE-bench 评分环境一键安装（WSL Ubuntu, root）
set -x

INIT=$(ps -p 1 -o comm= 2>/dev/null || true)
echo "INIT=$INIT"

# 1. Docker 安装
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
docker --version

# 2. Docker Hub 国内镜像加速（swebench 评测要拉大量 swebench/* 镜像）
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'EOF'
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://docker.1ms.run",
    "https://hub.rat.dev"
  ]
}
EOF

# 3. 启动 docker daemon
if [ "$INIT" = "systemd" ]; then
  systemctl enable --now docker
else
  service docker start || (nohup dockerd >/var/log/dockerd.log 2>&1 &)
fi
sleep 5
docker info 2>/dev/null | grep -E "Server Version" || (echo "dockerd 未起来，看日志:"; tail -20 /var/log/dockerd.log 2>/dev/null; exit 1)

# 4. swebench harness（清华 pypi 源；Ubuntu 24.04 pip 需要 --break-system-packages）
(pip install -i https://pypi.tuna.tsinghua.edu.cn/simple --break-system-packages swebench 2>&1 | tail -5) \
  || (pip3 install -i https://pypi.tuna.tsinghua.edu.cn/simple --break-system-packages swebench 2>&1 | tail -5)

python3 -c "import swebench, sys; print('swebench import OK, py', sys.version.split()[0])"

echo WSL_SETUP_DONE
