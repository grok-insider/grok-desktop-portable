import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import signal
import resource
import shutil
import subprocess
import sys
import time
import uuid


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    with temporary.open('w') as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def keep_evidence(scratch, output, cache, final=False):
    maximum=63*1024**2
    for item in scratch.iterdir():
        if not item.is_file() or item.suffix not in ['.json','.jsonl','.png','.txt','.log'] or item.name.endswith('.tmp'):
            continue
        if item.suffix=='.log' and not final:
            continue
        metadata=item.stat()
        signature=(metadata.st_dev,metadata.st_ino,metadata.st_size,metadata.st_mtime_ns)
        previous=cache.get(item.name)
        if previous==signature:
            continue
        size=min(metadata.st_size,262144) if item.suffix=='.log' else metadata.st_size
        target=output/item.name
        current=sum(value.stat().st_size for value in output.iterdir() if value.is_file())
        if size>16*1024**2 or current+size>maximum:
            raise RuntimeError('Persistent evidence limit exceeded')
        incremental=item.suffix=='.jsonl' and previous and previous[:2]==signature[:2] and previous[2]<=signature[2] and target.exists() and target.stat().st_size==previous[2]
        with item.open('rb') as source:
            source.seek(previous[2] if incremental else max(0,metadata.st_size-262144) if item.suffix=='.log' else 0)
            value=source.read(16*1024**2+1)
        assert len(value)<=16*1024**2 and current+len(value)<=maximum,'Evidence read exceeded bound'
        if incremental:
            with target.open('ab') as destination:
                destination.write(value);destination.flush();os.fsync(destination.fileno())
        else:
            temporary=output/(item.name+'.tmp')
            with temporary.open('wb') as destination:
                os.chmod(temporary,0o600);destination.write(value);destination.flush();os.fsync(destination.fileno())
            temporary.replace(target)
            descriptor=os.open(output,os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        cache[item.name]=(signature[0],signature[1],(previous[2] if incremental else 0)+len(value) if item.suffix=='.jsonl' else signature[2],signature[3])


def inside(config_path):
    config = json.loads(config_path.read_text())
    output = config_path.parent
    scratch = output / 'scratch'
    resource.setrlimit(resource.RLIMIT_NOFILE, (4096, 4096))
    uid, gid = os.getuid(), os.getgid()
    os.unshare(os.CLONE_NEWUSER)
    Path('/proc/self/setgroups').write_text('deny')
    Path('/proc/self/uid_map').write_text(f'{uid} {uid} 1')
    Path('/proc/self/gid_map').write_text(f'{gid} {gid} 1')
    os.unshare(os.CLONE_NEWNS)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.mount(None, b'/', None, 16384 | 262144, None):
        raise OSError(ctypes.get_errno(), 'Private mount propagation failed')
    if libc.mount(b'tmpfs', os.fsencode(scratch), b'tmpfs', 0, b'size=2g,mode=0700'):
        raise OSError(ctypes.get_errno(), 'Bounded scratch mount failed')
    stopping = False
    def stop(signum, frame):
        nonlocal stopping
        stopping = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    fixture_source = Path(config['fixture'])
    fixture_directory = scratch/'fixture'
    fixture_directory.mkdir(mode=0o700)
    fixture = fixture_directory/'direct_browser_fixture'
    shutil.copy2(fixture_source,fixture)
    shutil.copy2(fixture_source.parent/'fake_multiwriter_agent',fixture_directory/'fake_multiwriter_agent')
    seal=json.loads((output/'fixture-seal.json').read_text())
    assert digest(fixture)==seal['binarySha256'],'Copied fixture differs from its seal'
    assert digest(fixture_directory/'fake_multiwriter_agent')==seal['fakeAgentSha256'],'Copied fake agent differs from its seal'
    for relative,expected in config['scriptHashes'].items():
        assert digest(Path(config['portable'])/relative)==expected,'Soak source changed before launch'
    evidence_cache={}
    last_metrics=0.0
    allowed = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'XDG_RUNTIME_DIR', 'XDG_DATA_DIRS', 'XDG_CONFIG_DIRS', 'DBUS_SESSION_BUS_ADDRESS', 'NIX_LD', 'NIX_LD_LIBRARY_PATH']
    environment = {name:os.environ[name] for name in allowed if name in os.environ}
    environment.update(REMOTE_QA_RUN_ID=config['runId'], REMOTE_QA_SOAK='1', REMOTE_QA_SOAK_REQUIRE_ENVELOPE='1', REMOTE_QA_SOAK_SECONDS=str(config['durationSeconds']), REMOTE_QA_SOAK_INTERVAL_SECONDS=str(config['intervalSeconds']), REMOTE_QA_SOAK_MAX_CYCLES=str(config['cycles']), REMOTE_QA_CHROME=config['chrome'], REMOTE_QA_PLAYWRIGHT=config['playwright'], DIRECT_QA_NATIVE_BINARY=str(fixture), DIRECT_QA_FIXTURE_MANIFEST=str(output / 'fixture-seal.json'), REMOTE_QA_ARTIFACT=config['artifact'], REMOTE_QA_SPANREED=config['spanreed'])
    if config.get('fault'):
        environment['REMOTE_QA_SOAK_FAULT'] = config['fault']
    if config.get('nativeRssMiB'):
        environment['REMOTE_QA_SOAK_NATIVE_RSS_MIB'] = str(config['nativeRssMiB'])
    subprocess.run([config['openssl'], 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-keyout', str(scratch / 'key.pem'), '-out', str(scratch / 'cert.pem'), '-subj', '/CN=direct-fixture.test', '-addext', 'subjectAltName=DNS:direct-fixture.test,DNS:direct-fixture-b.test,DNS:grok.fabrials.com,DNS:desktop.grok.me,DNS:remote.fabrials.com'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=environment)
    (scratch / 'key.pem').chmod(0o600)
    started = time.monotonic()
    with (scratch / 'runner.log').open('wb') as log:
        child = subprocess.Popen([config['bun'], str(Path(config['portable']) / 'scripts/qualify-direct-browser.ts'), str(scratch)], cwd=config['portable'], env=environment, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        original = Path(f'/proc/{child.pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
        injected = False
        try:
            while child.poll() is None:
                keep_evidence(scratch, output, evidence_cache)
                group=next(value[3:] for value in Path('/proc/self/cgroup').read_text().splitlines() if value.startswith('0::'))
                cgroup=Path('/sys/fs/cgroup')/group.lstrip('/')
                metrics={name:(cgroup/name).read_text().strip() for name in ['memory.current','memory.max','memory.events','pids.current','pids.max','pids.events','cpu.max']}
                if time.monotonic()-last_metrics>=5:
                    write_json(output/'cgroup-metrics.json',metrics)
                    last_metrics=time.monotonic()
                if config.get('killAfterSeconds') and (scratch / 'soak-checkpoint.json').exists() and time.monotonic() - started >= config['killAfterSeconds']:
                    child.kill()
                    injected = True
                    break
                if stopping:
                    child.terminate()
                    break
                time.sleep(0.5)
            try:
                result = child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                result = child.wait(timeout=5)
            keep_evidence(scratch, output, evidence_cache, final=True)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
            log.flush()
            with (scratch / 'runner.log').open('rb') as source:
                source.seek(max(0,source.seek(0,os.SEEK_END)-262144));text=source.read(262144)
            (output / 'runner.log').write_bytes(text)
            (output / 'runner.log').chmod(0o600)
            write_json(output / 'bounded-run.json', {'mountNamespaceId':os.readlink('/proc/self/ns/mnt'),'runnerPid':child.pid, 'runnerStartTicks':original, 'runnerExitCode':child.returncode, 'elapsedSeconds':time.monotonic()-started, 'killInjected':injected, 'interrupted':stopping, 'scratchCapacityBytes':os.statvfs(scratch).f_blocks * os.statvfs(scratch).f_frsize, 'fileDescriptorLimit':resource.getrlimit(resource.RLIMIT_NOFILE),'descendantCleanupOwner':'systemd scope KillMode=control-group and RuntimeMaxSec; outer launcher verifies retirement'})
    return 0 if result == 0 else 1


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--inside':
        return inside(Path(sys.argv[2]))
    parser = argparse.ArgumentParser()
    parser.add_argument('output', type=Path)
    parser.add_argument('--artifact', type=Path, required=True)
    parser.add_argument('--spanreed', type=Path, required=True)
    parser.add_argument('--libs', type=Path, required=True)
    parser.add_argument('--chrome', type=Path, required=True)
    parser.add_argument('--playwright', type=Path, required=True)
    parser.add_argument('--openssl', type=Path, required=True)
    parser.add_argument('--bun', type=Path, default=Path('/run/current-system/sw/bin/bun'))
    parser.add_argument('--duration-seconds', type=int, default=120)
    parser.add_argument('--interval-seconds', type=int, default=300)
    parser.add_argument('--cycles', type=int, default=1000)
    parser.add_argument('--tasks', type=int, default=512)
    parser.add_argument('--fault', choices=['duplicate'])
    parser.add_argument('--native-rss-mib', type=int)
    parser.add_argument('--kill-after-seconds', type=int)
    args = parser.parse_args()
    assert 16 <= args.tasks <= 512
    assert 10 <= args.duration_seconds <= 86400 and 1 <= args.interval_seconds <= 3600 and 2 <= args.cycles <= 10000
    output = args.output.resolve()
    output.mkdir(mode=0o700)
    (output / 'scratch').mkdir(mode=0o700)
    root = Path(__file__).resolve().parents[2]
    fixture = args.libs.resolve() / 'target/debug/examples/direct_browser_fixture'
    source = args.libs.resolve() / 'crates/fabrials-remote-host/examples/direct_browser_fixture.rs'
    commit = subprocess.check_output(['git', '-C', str(args.libs), 'rev-parse', 'HEAD'], text=True).strip()
    assert not subprocess.check_output(['git', '-C', str(args.libs), 'status', '--porcelain'], text=True).strip(), 'Fixture source tree must be clean'
    changed = subprocess.check_output(['git', '-C', str(args.libs), 'diff', '--name-only', 'ee3060d', commit], text=True).splitlines()
    assert changed == ['crates/fabrials-remote-host/examples/direct_browser_fixture.rs'], 'Soak source may only extend the test fixture'
    write_json(output / 'fixture-seal.json', {'schema':1, 'commit':commit, 'runtimeBaseCommit':'ee3060d', 'sourceSha256':digest(source), 'binarySha256':digest(fixture), 'fakeAgentSha256':digest(fixture.parent / 'fake_multiwriter_agent'), 'scope':'Recorded local build provenance; only example lifetime differs from the r3 runtime. Not a reproducible-build attestation.'})
    config = {'runId':uuid.uuid4().hex, 'portable':str(root), 'fixture':str(fixture), 'artifact':str(args.artifact.resolve()), 'spanreed':str(args.spanreed.resolve()), 'chrome':str(args.chrome.resolve()), 'playwright':str(args.playwright.resolve()), 'openssl':str(args.openssl.resolve()), 'bun':str(args.bun.resolve()), 'durationSeconds':args.duration_seconds, 'intervalSeconds':args.interval_seconds, 'cycles':args.cycles, 'fault':args.fault, 'nativeRssMiB':args.native_rss_mib, 'killAfterSeconds':args.kill_after_seconds,'portableCommit':subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip(),'portableDirty':bool(subprocess.check_output(['git','-C',str(root),'status','--porcelain'],text=True).strip()),'scriptHashes':{name:digest(root/name) for name in ['scripts/qualify-direct-browser.ts','scripts/qa/direct-soak.ts','scripts/qa/direct-multihost.ts','scripts/qa/run-direct-soak.py']}}
    config_path = output / 'bounded-config.json'
    write_json(config_path, config)
    unit = 'fabrials-direct-soak-' + uuid.uuid4().hex[:12]
    allowed = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'XDG_RUNTIME_DIR', 'XDG_DATA_DIRS', 'XDG_CONFIG_DIRS', 'DBUS_SESSION_BUS_ADDRESS', 'NIX_LD', 'NIX_LD_LIBRARY_PATH']
    command = ['systemd-run', '--user', '--scope', '--collect', '--quiet', '--unit='+unit, '--property=MemoryMax=6G', '--property=MemorySwapMax=0', '--property=TasksMax='+str(args.tasks), '--property=CPUQuota=200%', '--property=KillMode=control-group', '--property=TimeoutStopSec=15', '--property=RuntimeMaxSec='+str(args.duration_seconds+180)]
    environment = {name:os.environ[name] for name in allowed if name in os.environ}
    command += [sys.executable, str(Path(__file__).resolve()), '--inside', str(config_path)]
    write_json(output/'unit-launch.json', {'unit':unit,'launcherPid':os.getpid(),'limits':{'memoryBytes':6*1024**3,'swapBytes':0,'tasks':args.tasks,'cpuCores':2,'fileDescriptorsPerProcess':4096,'scratchBytes':2*1024**3,'persistentEvidenceBytes':64*1024**2},'runtimeMaxSeconds':args.duration_seconds+180})
    def stop_unit(signum, frame):
        subprocess.run(['systemctl','--user','stop',unit+'.scope'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20)
    signal.signal(signal.SIGTERM,stop_unit)
    signal.signal(signal.SIGINT,stop_unit)
    started = time.monotonic()
    with (output / 'unit.log').open('wb') as log:
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, env=environment)
        group = None
        try:
            while process.poll() is None:
                if group is None:
                    names=['ControlGroup','RuntimeMaxUSec','KillMode','TimeoutStopUSec','MemoryMax','MemorySwapMax','TasksMax','CPUQuotaPerSecUSec']
                    result = subprocess.run(['systemctl','--user','show',unit+'.scope','--property='+','.join(names)],capture_output=True,text=True,timeout=5)
                    properties=dict(line.split('=',1) for line in result.stdout.splitlines() if '=' in line)
                    group=properties.get('ControlGroup') or None
                    if group:
                        assert properties['KillMode']=='control-group' and properties['RuntimeMaxUSec'] not in ['', 'infinity', '0'], 'Scope lacks effective lifetime or cleanup control'
                        write_json(output/'unit-properties.json',properties)
                time.sleep(0.5)
            code = process.wait()
        finally:
            try:
                stop_result=subprocess.run(['systemctl','--user','stop',unit+'.scope'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20)
                if process.poll() is None: process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                write_json(output/'unit-cleanup-failed.json',{'unit':unit,'reason':'Unit stop or retirement deadline exceeded','requiresReconciliation':True})
                raise RuntimeError('Unit retirement failed; preserved checkpoints require reconciliation')
    present = False
    if group:
        group_path = Path('/sys/fs/cgroup') / group.lstrip('/')
        if group_path.exists():
            for path in group_path.rglob('cgroup.procs'):
                try:
                    present = present or bool(path.read_text().strip())
                except FileNotFoundError:
                    pass
    else:
        present = True
    empty_scratch = not any((output / 'scratch').iterdir())
    namespace=None
    if (output/'bounded-run.json').exists():
        namespace=json.loads((output/'bounded-run.json').read_text()).get('mountNamespaceId')
    inherited_marker=('REMOTE_QA_RUN_ID='+config['runId']).encode()
    remaining=[]
    inaccessible=0
    for candidate in Path('/proc').iterdir():
        if not candidate.name.isdigit():
            continue
        try:
            if candidate.stat().st_uid!=os.getuid():
                continue
            namespace_match=namespace and os.readlink(candidate/'ns/mnt')==namespace
            marker_match=inherited_marker in (candidate/'environ').read_bytes().split(b'\0')
            if namespace_match or marker_match:
                remaining.append({'pid':int(candidate.name),'privateMountNamespace':bool(namespace_match),'inheritedRunMarker':marker_match})
        except FileNotFoundError:
            pass
        except PermissionError:
            inaccessible+=1
    passed = code == 0 and not present and empty_scratch and not remaining
    write_json(output / 'unit-result.json', {'schema':1, 'unit':unit, 'controlGroup':group, 'exitCode':code, 'elapsedSeconds':time.monotonic()-started, 'cgroupEmpty':not present, 'outerScratchDirectoryEmpty':empty_scratch, 'remainingTaggedOrNamespaceProcesses':remaining,'unreadableSameUserProcesses':inaccessible, 'result':'passed' if passed else 'failed'})
    print(json.dumps({'result':'passed' if passed else 'failed', 'unit':unit, 'cgroupEmpty':not present, 'outerScratchDirectoryEmpty':empty_scratch, 'output':str(output)}))
    return 0 if passed else 1


if __name__ == '__main__':
    raise SystemExit(main())
