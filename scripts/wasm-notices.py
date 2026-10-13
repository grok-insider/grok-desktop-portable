import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import tomllib

LIMIT = 4 * 1024 * 1024
LICENSE_NAME = re.compile(r"^(LICENSE|LICENCE|COPYING|COPYRIGHT|NOTICE|UNLICENSE)(?:[-_.].*)?$", re.I)
ALLOWED = {"MIT", "MIT OR Apache-2.0", "Apache-2.0 OR MIT", "MIT/Apache-2.0", "BSD-3-Clause", "Unlicense OR MIT", "(MIT OR Apache-2.0) AND Unicode-3.0"}
HEADER = b"Rust/WASM third-party notices\n\nThis supplement accompanies the Grok Remote Noise WebAssembly module and its generated JavaScript glue.\nIt conservatively includes the target-filtered Cargo normal/build dependency closure, including build-time macros, and Rust standard-library source notices for all platforms. Some components may be removed by compilation.\nOriginal license and notice file bytes appear between the named separators without normalization.\nThis supplements the PWA JavaScript, CSS and font notices and does not qualify native Spanreed binary distribution.\n\n"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def plain(path, limit=LIMIT):
    path = Path(path)
    require(path.is_file() and not path.is_symlink(), f"Expected regular file: {path.name}")
    require(path.stat().st_size <= limit, f"Oversized file: {path.name}")
    return path.read_bytes()


def relative(name):
    p = PurePosixPath(name)
    require(not p.is_absolute() and str(p) == name and not any(x in ("", ".", "..") for x in p.parts), "Unsafe relative path")
    return name


def notice_bytes(data):
    require(0 < len(data) <= 512 * 1024 and b"\0" not in data, "Invalid notice size or NUL")
    data.decode("utf-8", errors="strict")
    return data


def command(args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True)


def artifact_inputs(artifact):
    artifact = Path(artifact)
    deployment_bytes = plain(artifact / "deployment.json")
    deployment = json.loads(deployment_bytes)
    require(deployment.get("schema") == 1 and deployment.get("format") == "vercel-build-output-v3", "Unsupported artifact")
    static = artifact / ".vercel/output/static"
    refs = {}
    for key, suffix in (("wasm", ".wasm"), ("javascript", ".js")):
        paths = [n for n in deployment["files"] if n.startswith(".vercel/output/static/crypto/") and n.endswith(suffix)]
        require(len(paths) == 1, f"Expected one crypto {key}")
        name = relative(paths[0])
        value = plain(artifact / name)
        require(digest(value) == deployment["files"][name], "Artifact crypto integrity mismatch")
        refs[key] = {"path": "/" + name.removeprefix(".vercel/output/static/"), "sha256": digest(value)}
    source_path = deployment["correspondingSource"]
    require(isinstance(source_path, str) and re.fullmatch(r"/sources/[a-f0-9]{64}\.json", source_path), "Missing source metadata")
    metadata = json.loads(plain(static / source_path[1:]))
    archive_path = metadata["archive"]["path"]
    require(re.fullmatch(r"/sources/[a-f0-9]{64}\.tar\.gz", archive_path), "Unsafe source archive")
    archive = static / archive_path[1:]
    require(file_digest(archive) == metadata["archive"]["sha256"], "Source archive checksum mismatch")
    with tarfile.open(archive, "r:gz") as source:
        member = source.getmember("spanreed/vendor/fabrials-libs/Cargo.lock")
        require(member.isfile() and member.size < LIMIT, "Invalid source Cargo.lock")
        lock = source.extractfile(member).read()
    require(metadata["sources"]["libs"] == deployment["sources"]["libs"], "Inconsistent source identity")
    return {"artifactDeploymentSha256": digest(deployment_bytes), **refs, "cargoLockSha256": digest(lock),
            "libsCommit": deployment["sources"]["libs"]["commit"], "rustc": deployment["toolchain"]["rustc"]}, tomllib.loads(lock.decode()), lock


def section(component, path, data):
    require(re.fullmatch(r"[A-Za-z0-9_.@+/-]+", component) is not None, "Invalid component")
    relative(path)
    return {"component": component, "path": path, "data": notice_bytes(data)}


def render(sections):
    output = bytearray(HEADER)
    records = []
    for entry in sorted(sections, key=lambda s: (s["component"], s["path"])):
        prefix = f"===== {entry['component']} / {entry['path']} =====\n".encode()
        output.extend(prefix)
        data = entry["data"]
        records.append({"component": entry["component"], "path": entry["path"], "offset": len(output), "bytes": len(data), "sha256": digest(data)})
        output.extend(data)
        output.extend(b"\n===== END ORIGINAL FILE =====\n\n")
    require(len(output) <= LIMIT, "Supplement exceeds size limit")
    return bytes(output), records


def registry_notices(metadata, lock, cargo_home):
    packages = {p["id"]: p for p in metadata["packages"]}
    nodes = {n["id"]: n for n in metadata["resolve"]["nodes"]}
    roots = [p for p in packages.values() if p["name"] == "fabrials-remote-noise"]
    require(len(roots) == 1, "Expected one Noise root")
    pending, seen = [roots[0]["id"]], set()
    while pending:
        item = pending.pop()
        if item in seen:
            continue
        seen.add(item)
        pending.extend(d["pkg"] for d in nodes[item]["deps"] if any(k["kind"] in (None, "build") for k in d["dep_kinds"]))
    locked = {(p["name"], p["version"]): p for p in lock["package"] if p.get("source") == "registry+https://github.com/rust-lang/crates.io-index"}
    records, sections = [], []
    for package in sorted((packages[i] for i in seen), key=lambda p: (p["name"], p["version"])):
        if package["id"] == roots[0]["id"]:
            require(package["source"] is None and package["license"] == "AGPL-3.0-or-later", "Unexpected Noise license")
            continue
        name, version = package["name"], package["version"]
        identity = f"{name}@{version}"
        require(package["license"] in ALLOWED, f"Unreviewed license: {identity}")
        require((name, version) in locked, f"Package missing from exact source lock: {identity}")
        checksum = locked[name, version]["checksum"]
        cached = sorted((cargo_home / "registry/cache").glob(f"*/{name}-{version}.crate"))
        require(len(cached) >= 1, f"Cached original .crate required: {identity}")
        archives = [path for path in cached if file_digest(path) == checksum]
        require(archives, f"Crate checksum mismatch: {identity}")
        component_sections = []
        with tarfile.open(archives[0], "r:gz") as archive:
            manifest = tomllib.loads(archive.extractfile(f"{name}-{version}/Cargo.toml").read().decode())
            require(manifest["package"]["license"] == package["license"], "Crate license differs from metadata")
            for member in archive:
                path = str(PurePosixPath(member.name).relative_to(f"{name}-{version}"))
                if LICENSE_NAME.fullmatch(PurePosixPath(path).name):
                    require(member.isfile() and member.size <= 512 * 1024, "Invalid crate notice")
                    component_sections.append(section(identity, path, archive.extractfile(member).read()))
        require(component_sections, f"Missing original license: {identity}")
        sections.extend(component_sections)
        records.append({"name": name, "version": version, "license": package["license"], "crateSha256": checksum,
                        "noticePaths": sorted(s["path"] for s in component_sections)})
    require(records, "Empty Rust dependency inventory")
    return records, sections


def standard_notices(archive_path, doc, rustc):
    match = re.fullmatch(r"rustc ([0-9]+\.[0-9]+\.[0-9]+) \(([^)]+)\)(?: \(built from a source tarball\))?", rustc)
    require(match is not None, "Unsupported Rust identity")
    version = f"{match[1]} ({match[2]})"
    root = f"rustc-{match[1]}-src/"
    notices, version_bytes = [], None
    roots = {"LICENSE-MIT", "LICENSE-APACHE", "COPYRIGHT"}
    extra = {f"LICENSES/{name}.txt" for name in ("Unicode-3.0", "BSD-2-Clause", "MIT", "Apache-2.0", "LLVM-exception", "NCSA", "ISC")}
    with tarfile.open(archive_path, "r|gz") as archive:
        for member in archive:
            if member.isdir() and member.name.rstrip("/") == root.rstrip("/"):
                continue
            require(member.name.startswith(root), "Unexpected Rust source archive root")
            name = member.name[len(root):]
            if name == "version":
                version_bytes = archive.extractfile(member).read()
            selected = name in roots | extra or (name.startswith("library/") and LICENSE_NAME.fullmatch(PurePosixPath(name).name))
            if selected:
                require(member.isfile() and member.size <= 512 * 1024, "Invalid Rust license file")
                notices.append(section(f"rust-standard-library@{match[1]}", name, archive.extractfile(member).read()))
    require(version_bytes is not None and version_bytes.decode().strip() == version, "Rust source version differs from artifact toolchain")
    names = {s["path"] for s in notices}
    require(roots | extra <= names, "Missing Rust license texts")
    require("library/compiler-builtins/LICENSE.txt" in names and "library/compiler-builtins/libm/LICENSE.txt" in names, "Missing compiler builtins notices")
    copyright_doc = plain(doc)
    require(b"Copyright notices for The Rust Standard Library" in copyright_doc and b"1991-2024 Unicode" in copyright_doc, "Unexpected Rust copyright document")
    notices.append(section(f"rust-standard-library@{match[1]}", "COPYRIGHT-library.html", copyright_doc))
    return {"version": version, "sourceArchiveSha256": file_digest(archive_path), "copyrightSha256": digest(copyright_doc), "noticePaths": sorted(s["path"] for s in notices)}, notices


def generate(args):
    inputs, lock, lock_bytes = artifact_inputs(args.artifact)
    libs = Path(args.libs)
    require(command(["git", "rev-parse", "HEAD"], libs).strip() == inputs["libsCommit"], "Wrong libs revision")
    require(not command(["git", "status", "--porcelain", "--untracked-files=normal"], libs), "Libs checkout must be clean")
    require(plain(libs / "Cargo.lock") == lock_bytes, "Libs lock differs from corresponding source")
    require(command(["rustc", "--version"]).strip() == inputs["rustc"], "Current Rust differs from build")
    metadata = json.loads(command(["cargo", "metadata", "--locked", "--offline", "--format-version=1", "--filter-platform", "wasm32-unknown-unknown"], libs))
    packages, sections = registry_notices(metadata, lock, Path(args.cargo_home))
    standard, standard_sections = standard_notices(args.rust_source_archive, args.rust_copyright, inputs["rustc"])
    content, index = render(sections + standard_sections)
    sha = digest(content)
    descriptor = {"schema": 1, **inputs, "supplement": {"path": f"/sources/{sha}.wasm-notices.txt", "sha256": sha, "bytes": len(content)},
                  "packages": packages, "standardLibrary": standard, "sections": index}
    destination = Path(args.notices)
    destination.mkdir(parents=True, exist_ok=False)
    (destination / "sources").mkdir()
    (destination / descriptor["supplement"]["path"][1:]).write_bytes(content)
    (destination / "wasm-notices.json").write_text(json.dumps(descriptor, indent=2) + "\n")
    verify(args)


def verify(args):
    inputs, lock, _ = artifact_inputs(args.artifact)
    root = Path(args.notices)
    descriptor = json.loads(plain(root / "wasm-notices.json"))
    require(descriptor["schema"] == 1, "Unsupported notice descriptor")
    for key, value in inputs.items():
        require(descriptor.get(key) == value, f"Notice input mismatch: {key}")
    item = descriptor["supplement"]
    require(re.fullmatch(r"[a-f0-9]{64}", item["sha256"]) is not None, "Invalid supplement digest")
    require(item["path"] == f"/sources/{item['sha256']}.wasm-notices.txt", "Unsafe supplement path")
    content = plain(root / item["path"][1:])
    require(digest(content) == item["sha256"] and len(content) == item["bytes"], "Supplement integrity mismatch")
    expected = {"wasm-notices.json", item["path"][1:]}
    actual = set()
    for path in root.rglob("*"):
        require(not path.is_symlink(), "Supplement symlink forbidden")
        if path.is_file():
            actual.add(str(path.relative_to(root)))
    require(actual == expected, "Unexpected supplement payload")
    sections = []
    for record in descriptor["sections"]:
        require(type(record["offset"]) is int and type(record["bytes"]) is int and record["offset"] >= 0 and record["bytes"] > 0, "Invalid section range")
        data = content[record["offset"]:record["offset"] + record["bytes"]]
        require(len(data) == record["bytes"] and digest(data) == record["sha256"], "Original notice integrity mismatch")
        sections.append(section(record["component"], record["path"], data))
    rebuilt, indices = render(sections)
    require(content == rebuilt and descriptor["sections"] == indices, "Noncanonical notice sections")
    keys = [(s["component"], s["path"]) for s in sections]
    require(len(set(keys)) == len(keys), "Duplicate notice section")
    locked = {(p["name"], p["version"]): p for p in lock["package"] if p.get("source") == "registry+https://github.com/rust-lang/crates.io-index"}
    records = descriptor["packages"]
    require(records and len({(p['name'], p['version']) for p in records}) == len(records), "Missing or duplicate package inventory")
    expected_sections = set()
    for p in records:
        identity = p["name"], p["version"]
        require(identity in locked and locked[identity]["checksum"] == p["crateSha256"], "Package differs from source lock")
        require(p["license"] in ALLOWED and p["noticePaths"], "Unreviewed or empty license inventory")
        expected_sections.update((f"{p['name']}@{p['version']}", n) for n in p["noticePaths"])
    require(any(p["name"] == "snow" for p in records) and any(p["name"] == "wasm-bindgen" for p in records) and any(p["name"] == "curve25519-dalek" for p in records), "Required crypto attribution missing")
    standard = descriptor["standardLibrary"]
    version = inputs["rustc"].split()[1]
    require(standard["version"] in inputs["rustc"] and re.fullmatch(r"[a-f0-9]{64}", standard["sourceArchiveSha256"]), "Invalid Rust source identity")
    required_std = {"LICENSE-MIT", "LICENSE-APACHE", "COPYRIGHT", "COPYRIGHT-library.html", "LICENSES/Unicode-3.0.txt", "library/compiler-builtins/LICENSE.txt", "library/compiler-builtins/libm/LICENSE.txt"}
    require(required_std <= set(standard["noticePaths"]), "Required standard-library attribution missing")
    expected_sections.update((f"rust-standard-library@{version}", n) for n in standard["noticePaths"])
    require(set(keys) == expected_sections, "Incomplete attribution sections")
    copyright_records = [s for s in descriptor["sections"] if s["component"] == f"rust-standard-library@{version}" and s["path"] == "COPYRIGHT-library.html"]
    require(len(copyright_records) == 1 and copyright_records[0]["sha256"] == standard["copyrightSha256"], "Rust copyright integrity mismatch")
    print(json.dumps({"verified": True, "packages": len(records), "originalFiles": len(sections), "bytes": len(content), "supplement": item["path"]}))
    return descriptor


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="action", required=True)
    for action in ("generate", "verify"):
        child = sub.add_parser(action)
        child.add_argument("--artifact", required=True)
        child.add_argument("--notices", required=True)
        if action == "generate":
            child.add_argument("--libs", required=True)
            child.add_argument("--rust-source-archive", required=True)
            child.add_argument("--rust-copyright", required=True)
            child.add_argument("--cargo-home", default=str(Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo"))))
    args = parser.parse_args()
    (generate if args.action == "generate" else verify)(args)


if __name__ == "__main__":
    main()
