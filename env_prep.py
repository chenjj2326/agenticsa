# -*- coding: utf-8 -*-
"""Build per-repo scoring environments for SWE-bench Lite on Windows.

Pure-Python repos only. Compiled repos (matplotlib/sklearn/astropy) need MSVC — deferred.

Strategy: copytree the stable py39raw base (never conda create — see journey §坑17-19),
then pip install pinned deps via tsinghua mirror. Repo source is mounted via PYTHONPATH
at scoring time, so envs only carry dependencies, not the repo itself.
"""
import os
import shutil
import subprocess
import sys

BASE = r"E:\swe-envs\py39raw"
ROOT = r"E:\swe-envs"
MIRROR = "https://pypi.tuna.tsinghua.edu.cn/simple"

# repo -> (env name, deps pinned for the whole version spread in Lite)
ENVS = {
    "sympy": ("sympy-env", ["mpmath==1.2.1", "pytest==7.4.4"]),
    "sphinx": ("sphinx-env", ["sphinxcontrib-applehelp", "sphinxcontrib-devhelp",
                              "sphinxcontrib-htmlhelp", "sphinxcontrib-jsmath",
                              "sphinxcontrib-qthelp", "sphinxcontrib-serializinghtml",
                              "Jinja2", "pygments", "docutils", "snowballstemmer",
                              "babel", "alabaster", "imagesize", "pytest==7.4.4",
                              "html5lib", "packaging", "requests"]),
    "pytest": ("pytest-env", ["attrs", "more-itertools", "pluggy", "py", "packaging",
                              "six", "hypothesis", "xmlschema", "tomli", "setuptools",
                              "argcomplete"]),
    "xarray": ("xarray-env", ["numpy==1.23.5", "pandas==1.5.3", "pytest==7.4.4"]),
    "seaborn": ("seaborn-env", ["numpy==1.23.5", "pandas==1.5.3", "matplotlib==3.6.3",
                                "pytest==7.4.4"]),
    "pylint": ("pylint-env", ["astroid==2.11.13", "isort<5,>=4.2.5", "dill", "platformdirs",
                              "tomlkit", "wrapt", "mccabe", "toml", "pytest==7.4.4"]),
}


def run(cmd, **kw):
    print("+", " ".join(cmd))
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode != 0:
        print(r.stdout[-2000:])
        print(r.stderr[-2000:])
        raise SystemExit(f"FAILED: {' '.join(cmd)}")
    return r


def build(name):
    dest = os.path.join(ROOT, name)
    if os.path.isdir(dest):
        print(f"[skip] {dest} exists")
        return dest
    print(f"[copy] {BASE} -> {dest}")
    shutil.copytree(BASE, dest)
    return dest


def pip(env_dir, packages):
    py = os.path.join(env_dir, "python.exe")
    run([py, "-m", "pip", "install", "--no-warn-script-location",
         "-i", MIRROR, "--timeout", "60", *packages])


def main():
    only = sys.argv[1:] or list(ENVS)
    for repo in only:
        env_name, deps = ENVS[repo]
        d = build(env_name)
        print(f"[pip] {repo}: {len(deps)} packages")
        pip(d, deps)
        print(f"[ok] {repo} -> {d}")


if __name__ == "__main__":
    main()
