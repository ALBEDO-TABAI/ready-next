#!/usr/bin/env python3
"""
环境检测和依赖安装脚本
检测 video-copy-analyzer 所需的所有依赖
"""

import subprocess
import sys
import shutil

def check_command(cmd: str, version_arg: str = "--version") -> tuple[bool, str]:
    """检查命令行工具是否可用"""
    try:
        result = subprocess.run(
            [cmd, version_arg],
            capture_output=True,
            text=True,
            timeout=10
        )
        version = result.stdout.strip() or result.stderr.strip()
        return True, version.split('\n')[0]
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False, ""

def check_python_package(package: str) -> bool:
    """检查 Python 包是否已安装"""
    try:
        __import__(package)
        return True
    except ImportError:
        return False

def main():
    print("=" * 50)
    print("🔍 Video Copy Analyzer 环境检测")
    print("=" * 50)
    print()
    
    all_ok = True
    missing = []
    
    # 1. 检查 yt-dlp
    print("1️⃣ 检查 yt-dlp...")
    ok, version = check_command("yt-dlp")
    if ok:
        print(f"   ✅ yt-dlp: {version}")
    else:
        print("   ❌ yt-dlp 未安装")
        missing.append("pip install yt-dlp")
        all_ok = False
    
    # 2. 检查 FFmpeg
    print("2️⃣ 检查 FFmpeg...")
    ok, version = check_command("ffmpeg", "-version")
    if ok:
        print(f"   ✅ FFmpeg: {version[:50]}...")
    else:
        print("   ❌ FFmpeg 未安装")
        missing.append("下载 FFmpeg: https://ffmpeg.org/download.html")
        all_ok = False
    
    # 3. 检查 Python 依赖
    print("3️⃣ 检查 Python 依赖...")
    
    packages = {
        "funasr": "funasr",
        "modelscope": "modelscope",
        "pysrt": "pysrt",
        "dotenv": "python-dotenv",
        "torch": "torch"
    }
    
    pip_install = []
    for import_name, pip_name in packages.items():
        if check_python_package(import_name):
            print(f"   ✅ {pip_name}")
        else:
            print(f"   ❌ {pip_name} 未安装")
            pip_install.append(pip_name)
            all_ok = False
    
    # 4. 检查 CUDA (可选)
    print("4️⃣ 检查 CUDA (可选)...")
    try:
        import torch
        if torch.cuda.is_available():
            print(f"   ✅ CUDA 可用: {torch.cuda.get_device_name(0)}")
        else:
            print("   ⚠️ CUDA 不可用，将使用 CPU（转录速度较慢）")
    except ImportError:
        print("   ⚠️ PyTorch 未安装，无法检测 CUDA")
    
    print()
    print("=" * 50)
    
    if all_ok:
        print("✅ 所有依赖已满足，可以使用 video-copy-analyzer！")
    else:
        print("❌ 存在缺失依赖，请执行以下命令安装：")
        print()
        if pip_install:
            print(f"   pip install {' '.join(pip_install)}")
        for cmd in missing:
            if not cmd.startswith("pip"):
                print(f"   {cmd}")
    
    print("=" * 50)
    return 0 if all_ok else 1

if __name__ == "__main__":
    sys.exit(main())
