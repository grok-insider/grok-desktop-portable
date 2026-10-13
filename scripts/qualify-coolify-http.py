import argparse
import concurrent.futures
import datetime
import hashlib
import json
import pathlib
import subprocess
import tempfile
import re

ORIGIN = 'https://grok.fabrials.com'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--adapter', type=pathlib.Path, required=True)
    parser.add_argument('--receipt', type=pathlib.Path, required=True)
    parser.add_argument('--origin-ip')
    args = parser.parse_args()
    manifest_bytes = (args.adapter / 'adapter.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    assert manifest['origin'] == ORIGIN
    files = {name.removeprefix('static/'): digest for name, digest in manifest['files'].items() if name.startswith('static/')}
    assert 'index.html' in files and 0 < len(files) <= 1000
    nginx = (args.adapter / 'nginx.conf').read_text()
    expected_security = {}
    for name in ['Content-Security-Policy', 'X-Frame-Options', 'X-Content-Type-Options', 'Referrer-Policy', 'X-Robots-Tag', 'Strict-Transport-Security']:
        match = re.search(r'add_header ' + name + r' ("(?:[^"\\]|\\.)*") always;', nginx)
        assert match, f'Missing reviewed security header: {name}'
        expected_security[name.lower()] = json.loads(match.group(1))
    assert expected_security['strict-transport-security'] == 'max-age=31536000'
    checks = []
    responses = []

    def request(path, method='GET', extra_headers=()):
        assert path.startswith('/') and not path.startswith('//')
        with tempfile.TemporaryDirectory(prefix='grok-http-') as directory:
            headers_path = pathlib.Path(directory) / 'headers'
            body_path = pathlib.Path(directory) / 'body'
            command = ['curl', '--silent', '--show-error', '--path-as-is', '--max-time', '30', '--max-filesize', '268435456', '--user-agent', 'fabrials-grok-remote-qa/1.0', '-H', 'Accept-Encoding: identity', '-D', str(headers_path), '-o', str(body_path), '-w', '%{http_code}']
            if args.origin_ip:
                command += ['--resolve', 'grok.fabrials.com:443:' + args.origin_ip]
            if method == 'HEAD':
                command += ['--head']
            elif method != 'GET':
                command += ['--request', method]
            for name, value in extra_headers:
                command += ['-H', name + ': ' + value]
            command.append(ORIGIN + path)
            result = subprocess.run(command, capture_output=True, text=True, timeout=35)
            assert result.returncode == 0, f'HTTPS request failed for {method} {path}: curl exit {result.returncode}'
            lines = headers_path.read_text().splitlines()
            headers = {}
            for line in lines:
                if line.startswith('HTTP/'):
                    headers = {}
                elif ':' in line:
                    name, value = line.split(':', 1)
                    key = name.lower()
                    headers[key] = headers[key] + ', ' + value.strip() if key in headers else value.strip()
            body = b'' if method == 'HEAD' else body_path.read_bytes()
            return {'path': path, 'method': method, 'status': int(result.stdout), 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest(), 'headers': headers}

    def check(name, passed, response=None):
        checks.append({'name': name, 'passed': bool(passed)})
        if response is not None:
            responses.append(response)

    def security(r):
        h = r['headers']
        return all(h.get(name) == value for name, value in expected_security.items())

    root = request('/')
    check('root_bytes_match_candidate', root['status'] == 200 and root['sha256'] == files['index.html'], root)
    check('root_security_headers', security(root))
    check('root_revalidates', root['headers'].get('cache-control') == 'no-cache')
    check('trusted_tls_and_hsts', root['headers'].get('strict-transport-security') == 'max-age=31536000')
    for path in ['/setup', '/s/qa-route_1.0-a']:
        r = request(path)
        check('spa_route_' + path, r['status'] == 200 and r['sha256'] == files['index.html'] and r['headers'].get('cache-control') == 'no-cache' and security(r), r)
    r = request('/licenses')
    check('advertised_license_page', r['status'] == 200 and r['sha256'] == files['licenses.html'] and r['headers'].get('cache-control') == 'no-cache' and security(r), r)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        downloaded = list(pool.map(lambda name: (name, request('/' + name)), sorted(files)))
    for name, r in downloaded:
        check('file_bytes_' + name, r['status'] == 200 and r['sha256'] == files[name], r)
        check('file_security_' + name, security(r))
        if name.startswith(('assets/', 'crypto/', 'sources/')):
            check('immutable_' + name, r['headers'].get('cache-control') == 'public, max-age=31536000, immutable')
        elif name in ['install.sh', 'install.ps1']:
            check('installer_no_store_' + name, r['headers'].get('cache-control') == 'no-store')
        elif name in ['sw.js', 'manifest.webmanifest', 'index.html', 'theme-init.js']:
            check('fresh_' + name, r['headers'].get('cache-control') == 'no-cache')
        expected_mimes = {'.wasm': 'application/wasm', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.css': 'text/css', '.woff2': 'font/woff2', '.tar.gz': 'application/gzip'}
        for suffix, mime in expected_mimes.items():
            if name.endswith(suffix):
                check('mime_' + name, r['headers'].get('content-type', '').split(';')[0] == mime)
        if name.endswith('.wasm'):
            check('wasm_license_link', 'rel="license"' in r['headers'].get('link', '') or 'rel=license' in r['headers'].get('link', ''))
        if name == 'sw.js':
            check('service_worker_scope', r['headers'].get('service-worker-allowed') == '/')
    for path in ['/api/health', '/api/publications', '/not-a-route', '/s/', '/s/one/two', '/setup/extra', '/assets/missing.js', '/.env', '/adapter.json', '/nginx.conf']:
        r = request(path)
        check('missing_' + path, r['status'] == 404 and r['headers'].get('cache-control') == 'no-store' and security(r), r)
    for method in ['POST', 'PUT', 'DELETE', 'OPTIONS']:
        r = request('/', method)
        check('reject_method_' + method, r['status'] == 405 and r['headers'].get('cache-control') == 'no-store', r)
    asset = next(name for name in files if name.startswith('assets/') and name.endswith('.js'))
    r = request('/' + asset, 'POST')
    check('immutable_path_method_error_no_store', r['status'] == 405 and r['headers'].get('cache-control') == 'no-store', r)
    r = request('/' + asset, extra_headers=[('Range', 'bytes=999999999-')])
    check('range_error_not_cached', r['status'] == 416 and r['headers'].get('cache-control') == 'no-store', r)
    r = request('/' + asset, 'HEAD')
    check('head_preserves_headers', r['status'] == 200 and r['headers'].get('cache-control') == 'public, max-age=31536000, immutable', r)
    r = request('/' + asset, extra_headers=[('Range', 'bytes=0-15')])
    expected = (args.adapter / 'static' / asset).read_bytes()[:16]
    check('byte_ranges', r['status'] == 206 and r['bytes'] == 16 and r['sha256'] == hashlib.sha256(expected).hexdigest(), r)
    r = request('/' + asset + '?qualification=cache-key')
    check('query_does_not_change_asset', r['status'] == 200 and r['sha256'] == files[asset], r)
    if not args.origin_ip:
        r = request('/' + asset)
        check('cloudflare_serves_immutable_cache', r['headers'].get('cf-cache-status') == 'HIT', r)
        r = request('/')
        check('cloudflare_does_not_cache_shell', r['headers'].get('cf-cache-status') not in ['HIT', 'STALE', 'UPDATING'], r)
    receipt = {'schema': 1, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'origin': ORIGIN, 'originIp': args.origin_ip, 'adapterSha256': hashlib.sha256(manifest_bytes).hexdigest(), 'checks': checks, 'passed': sum(c['passed'] for c in checks), 'failed': sum(not c['passed'] for c in checks), 'responses': responses}
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'passed': receipt['passed'], 'failed': receipt['failed'], 'receipt': str(args.receipt), 'failures': [c['name'] for c in checks if not c['passed']]}))
    return 1 if receipt['failed'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
