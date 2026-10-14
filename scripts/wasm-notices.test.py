import copy
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("wasm_notices", Path(__file__).with_name("wasm-notices.py"))
notice = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notice)


class NoticesTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.input = {"artifactDeploymentSha256": "a" * 64, "wasm": {"path": "/crypto/module.wasm", "sha256": "b" * 64},
                      "javascript": {"path": "/crypto/module.js", "sha256": "c" * 64}, "cargoLockSha256": "d" * 64,
                      "libsCommit": "e" * 40, "rustc": "rustc 1.2.3 (abcdef123 2026-01-01)"}
        self.packages = [{"name": name, "version": "1.0.0", "license": "MIT", "crateSha256": "f" * 64, "noticePaths": ["LICENSE"]}
                         for name in ("curve25519-dalek", "snow", "wasm-bindgen")]
        self.lock = {"package": [{"name": p["name"], "version": p["version"], "checksum": p["crateSha256"], "source": "registry+https://github.com/rust-lang/crates.io-index"} for p in self.packages]}
        std = ["LICENSE-MIT", "LICENSE-APACHE", "COPYRIGHT", "COPYRIGHT-library.html", "LICENSES/Unicode-3.0.txt", "library/compiler-builtins/LICENSE.txt", "library/compiler-builtins/libm/LICENSE.txt"]
        self.sections = [notice.section(f"{p['name']}@{p['version']}", "LICENSE", b"Original license \r\nTrailing space  \n") for p in self.packages]
        self.sections.extend(notice.section("rust-standard-library@1.2.3", path, b"Original Rust notice \r\n") for path in std)
        self.descriptor = {"schema": 1, **self.input, "packages": copy.deepcopy(self.packages),
                           "standardLibrary": {"version": "1.2.3 (abcdef123 2026-01-01)", "sourceArchiveSha256": "0" * 64, "noticePaths": std, "copyrightSha256": notice.digest(b"Original Rust notice \r\n")}}
        self.args = SimpleNamespace(artifact="unused", notices=str(self.root))
        self.write_fixture()

    def write_fixture(self):
        content, records = notice.render(self.sections)
        sha = notice.digest(content)
        self.descriptor.update(supplement={"path": f"/sources/{sha}.wasm-notices.txt", "sha256": sha, "bytes": len(content)}, sections=records)
        (self.root / "sources").mkdir(exist_ok=True)
        for path in (self.root / "sources").iterdir():
            path.unlink()
        (self.root / self.descriptor["supplement"]["path"][1:]).write_bytes(content)
        self.save_descriptor()

    def save_descriptor(self):
        (self.root / "wasm-notices.json").write_text(json.dumps(self.descriptor))

    def verify(self):
        with patch.object(notice, "artifact_inputs", return_value=(self.input, self.lock, b"")), patch("builtins.print"):
            return notice.verify(self.args)

    def test_original_bytes_and_deterministic_order(self):
        self.verify()
        content, records = notice.render(self.sections)
        self.assertEqual((content, records), notice.render(list(reversed(self.sections))))
        for section, record in zip(sorted(self.sections, key=lambda s: (s["component"], s["path"])), records):
            self.assertEqual(section["data"], content[record["offset"]:record["offset"] + record["bytes"]])
        self.assertIn(b"license \r\nTrailing space  \n", content)

    def test_rejects_different_build_crypto_lock_and_toolchain(self):
        for key in self.input:
            with self.subTest(key=key):
                original = self.descriptor[key]
                self.descriptor[key] = None
                self.save_descriptor()
                with self.assertRaisesRegex(ValueError, "input mismatch"):
                    self.verify()
                self.descriptor[key] = original

    def test_rejects_notice_changes(self):
        file = self.root / self.descriptor["supplement"]["path"][1:]
        file.write_bytes(file.read_bytes().replace(b"Trailing space  ", b"Trailing space"))
        with self.assertRaisesRegex(ValueError, "integrity mismatch"):
            self.verify()

    def test_rejects_updated_top_digest_with_changed_original_file(self):
        file = self.root / self.descriptor["supplement"]["path"][1:]
        data = file.read_bytes().replace(b"Trailing space  ", b"Changed notice  ")
        sha = notice.digest(data)
        file.unlink()
        self.descriptor["supplement"] = {"path": f"/sources/{sha}.wasm-notices.txt", "sha256": sha, "bytes": len(data)}
        (self.root / self.descriptor["supplement"]["path"][1:]).write_bytes(data)
        self.save_descriptor()
        with self.assertRaisesRegex(ValueError, "Original notice integrity"):
            self.verify()

    def test_rejects_missing_component(self):
        self.sections = [s for s in self.sections if s["component"] != "snow@1.0.0"]
        self.write_fixture()
        with self.assertRaisesRegex(ValueError, "Incomplete attribution"):
            self.verify()

    def test_rejects_missing_crypto_inventory_even_if_sections_removed(self):
        self.descriptor["packages"] = [p for p in self.descriptor["packages"] if p["name"] != "snow"]
        self.sections = [s for s in self.sections if s["component"] != "snow@1.0.0"]
        self.write_fixture()
        with self.assertRaisesRegex(ValueError, "Required crypto attribution"):
            self.verify()

    def test_rejects_missing_unicode_or_compiler_builtins(self):
        for path in ("LICENSES/Unicode-3.0.txt", "library/compiler-builtins/LICENSE.txt"):
            with self.subTest(path=path):
                paths = self.descriptor["standardLibrary"]["noticePaths"]
                paths.remove(path)
                self.save_descriptor()
                with self.assertRaisesRegex(ValueError, "standard-library attribution"):
                    self.verify()
                paths.append(path)

    def test_rejects_wrong_package_checksum_and_unknown_license(self):
        self.descriptor["packages"][0]["crateSha256"] = "0" * 64
        self.save_descriptor()
        with self.assertRaisesRegex(ValueError, "source lock"):
            self.verify()
        self.descriptor["packages"][0]["crateSha256"] = "f" * 64
        self.descriptor["packages"][0]["license"] = "MPL-2.0"
        self.save_descriptor()
        with self.assertRaisesRegex(ValueError, "Unreviewed"):
            self.verify()

    def test_rejects_extra_payload_and_symlinks(self):
        extra = self.root / "extra"
        extra.write_text("extra")
        with self.assertRaisesRegex(ValueError, "Unexpected supplement payload"):
            self.verify()
        extra.unlink()
        extra.symlink_to(self.root / "wasm-notices.json")
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.verify()

    def test_rejects_unsafe_path_ranges_and_duplicate_sections(self):
        self.descriptor["supplement"]["path"] = "/sources/../../license"
        self.save_descriptor()
        with self.assertRaisesRegex(ValueError, "Unsafe supplement"):
            self.verify()
        self.write_fixture()
        self.descriptor["sections"][0]["offset"] = -1
        self.save_descriptor()
        with self.assertRaisesRegex(ValueError, "Invalid section range"):
            self.verify()
        self.sections.append(self.sections[0])
        self.write_fixture()
        with self.assertRaisesRegex(ValueError, "Duplicate notice section"):
            self.verify()

    def test_rejects_wrong_rust_copyright_digest(self):
        self.descriptor["standardLibrary"]["copyrightSha256"] = "f" * 64
        self.save_descriptor()
        with self.assertRaisesRegex(ValueError, "Rust copyright"):
            self.verify()

    def test_registry_notices_use_original_archive_and_lock_checksum(self):
        cache = self.root / "registry/cache/example"
        cache.mkdir(parents=True)
        archive_path = cache / "snow-1.0.0.crate"
        with tarfile.open(archive_path, "w:gz") as archive:
            for name, data in {"Cargo.toml": b'[package]\nlicense="MIT"\n', "LICENSE": b"License original \r\n"}.items():
                member = tarfile.TarInfo(f"snow-1.0.0/{name}")
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
        metadata = {"packages": [{"id": "root", "name": "fabrials-remote-noise", "version": "0.1.0", "source": None, "license": "AGPL-3.0-or-later"},
                                 {"id": "snow", "name": "snow", "version": "1.0.0", "source": "registry", "license": "MIT"}],
                    "resolve": {"nodes": [{"id": "root", "deps": [{"pkg": "snow", "dep_kinds": [{"kind": None}]}]}, {"id": "snow", "deps": []}]}}
        lock = {"package": [{"name": "snow", "version": "1.0.0", "checksum": notice.file_digest(archive_path), "source": "registry+https://github.com/rust-lang/crates.io-index"}]}
        records, sections = notice.registry_notices(metadata, lock, self.root)
        self.assertEqual(sections[0]["data"], b"License original \r\n")
        self.assertEqual(records[0]["crateSha256"], notice.file_digest(archive_path))
        archive_path.write_bytes(archive_path.read_bytes() + b"tamper")
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            notice.registry_notices(metadata, lock, self.root)


if __name__ == "__main__":
    unittest.main()
