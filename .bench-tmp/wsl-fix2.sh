#!/usr/bin/env bash
# WSL fix2: MTU 黑洞修复 + 坏包修复 + 重装 docker.io / python3-pip / swebench
set -x

# 1. WSL2 MTU 黑洞：大包（.deb 下载）超时的经典原因
ip link set dev eth0 mtu 1400 || true
ip link show eth0 | grep mtu

# 2. 修复处于坏状态的 libpam-cap
DEBIAN_FRONTEND=noninteractive apt-get install -y --reinstall -o Acquire::ForceIPv4=true libpam-cap
dpkg --configure -a

# 3. 装 docker.io + python3-pip
DEBIAN_FRONTEND=noninteractive apt-get install -y -o Acquire::ForceIPv4=true docker.io python3-pip

docker --version

# 4. Docker Hub 镜像加速 + 启动
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
systemctl enable --now docker
sleep 5
docker info 2>/dev/null | grep -E "Server Version|Registry Mirrors" -A4 || (echo "--- dockerd failed:"; journalctl -u docker --no-pager | tail -30; exit 1)

# 5. swebench（清华 pypi）
pip3 install -i https://pypi.tuna.tsinghua.edu.cn/simple --break-system-packages swebench 2>&1 | tail -3
python3 -c "import swebench; print('swebench OK')"

echo WSL_FIX2_DONE
