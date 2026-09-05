#!/usr/bin/env bash
# WSL 修复：dpkg 残留 + 换清华源（IPv4）+ 装 docker.io / python3-pip / swebench
set -x

# 0. 修复被中断的 dpkg
dpkg --configure -a

# 1. apt 换清华镜像源（Ubuntu 24.04 是 deb822 格式 ubuntu.sources）
if [ -f /etc/apt/sources.list.d/ubuntu.sources ]; then
  sed -i.bak 's|http://archive.ubuntu.com/ubuntu|https://mirrors.tuna.tsinghua.edu.cn/ubuntu|g; s|http://security.ubuntu.com/ubuntu|https://mirrors.tuna.tsinghua.edu.cn/ubuntu|g' /etc/apt/sources.list.d/ubuntu.sources
fi
[ -f /etc/apt/sources.list ] && sed -i.bak 's|http://archive.ubuntu.com/ubuntu|https://mirrors.tuna.tsinghua.edu.cn/ubuntu|g; s|http://security.ubuntu.com/ubuntu|https://mirrors.tuna.tsinghua.edu.cn/ubuntu|g' /etc/apt/sources.list

# 2. 安装 docker.io + python3-pip（强制 IPv4）
apt-get update -o Acquire::ForceIPv4=true
DEBIAN_FRONTEND=noninteractive apt-get install -y -o Acquire::ForceIPv4=true docker.io python3-pip

docker --version

# 3. Docker Hub 国内镜像加速
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

# 4. systemd 启动 docker
systemctl enable --now docker
sleep 5
docker info 2>/dev/null | grep -E "Server Version|Registry Mirrors" -A4 || (echo "--- dockerd 启动失败:"; journalctl -u docker --no-pager | tail -30; exit 1)

# 5. swebench harness（清华 pypi）
pip3 install -i https://pypi.tuna.tsinghua.edu.cn/simple --break-system-packages swebench 2>&1 | tail -3
python3 -c "import swebench; print('swebench OK')"

echo WSL_FIX_DONE
