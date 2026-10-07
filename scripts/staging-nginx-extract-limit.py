#!/usr/bin/env python3
"""LOOP 8.6C (staging) · nginx: 40 MB SOLO en la lectura de documentos del API de STAGING.

Problema: nginx rechazaba con 413 todo cuerpo de más de ~1 MB (client_max_body_size por defecto) antes de llegar a
Cursia, así que un microcurrículo PDF de varios MB nunca se podía leer en staging.

Qué hace (idempotente):
  1. Busca el archivo de nginx con el bloque `server` cuyo server_name es EXACTAMENTE el de staging y que hace
     proxy (`location / { … proxy_pass … }`). Ningún otro bloque `server` (producción, el redirect :80…) se toca,
     aunque esté en el mismo archivo.
  2. Inserta, ANTES de `location /`, una location solo para las dos rutas de lectura
     (`/api/v1/courses/<id>/academic-context/extract` y `extract-advanced`) con las MISMAS directivas de proxy de
     `location /` + `client_max_body_size 40m`. El resto del API conserva su límite.
  3. Copia de seguridad → `nginx -t` → `systemctl reload nginx` (recarga sin cortar conexiones). Si `nginx -t`
     falla, restaura la copia y termina con error (nginx nunca queda con una configuración inválida).

Uso (en el VPS, con sudo):  python3 staging-nginx-extract-limit.py <server_name> <limite>   p. ej. api-staging.cursia.nomaddi.com 40m
Prueba local (sin nginx):    python3 staging-nginx-extract-limit.py --self-test
"""
import glob
import os
import re
import shutil
import subprocess
import sys
import time

MARK = '# cursia-8.6c: lectura de documentos'
LOCATION_RE = r'^/api/v1/courses/[0-9]+/academic-context/(extract|extract-advanced)/?$'


def find_blocks(text):
    """[(inicio, fin)] de cada bloque `server { … }` de primer nivel (fin = índice después de la llave que cierra)."""
    out = []
    for m in re.finditer(r'(^|\n)\s*server\s*\{', text):
        start = m.start() if m.group(1) == '' else m.start() + 1
        depth = 0
        i = text.index('{', m.start())
        while i < len(text):
            c = text[i]
            if c == '#':
                nl = text.find('\n', i)
                i = len(text) if nl < 0 else nl
                continue
            if c == '{':
                depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    out.append((start, i + 1))
                    break
            i += 1
    return out


def location_root(block):
    """(inicio, fin, cuerpo) de `location / { … }` dentro de un bloque server, o None."""
    m = re.search(r'\n([ \t]*)location\s+/\s*\{', block)
    if not m:
        return None
    i = block.index('{', m.start())
    depth = 0
    j = i
    while j < len(block):
        if block[j] == '{':
            depth += 1
        elif block[j] == '}':
            depth -= 1
            if depth == 0:
                return m.start() + 1, j + 1, block[i + 1:j], m.group(1)
        j += 1
    return None


def patch(text, server_name, limit):
    """Devuelve (texto nuevo, estado) — estado: 'patched' | 'already' | 'no-server' | 'no-proxy'."""
    for (a, b) in find_blocks(text):
        block = text[a:b]
        names = re.search(r'\n\s*server_name\s+([^;]+);', block)
        if not names or server_name not in names.group(1).split():
            continue
        loc = location_root(block)
        if not loc or 'proxy_pass' not in loc[2]:
            continue  # p. ej. el bloque :80 que solo redirige
        if MARK in block:
            # Ya está: solo se actualiza el límite si cambió.
            new_block = re.sub(r'(' + re.escape(MARK) + r'[^\n]*\n[^\n]*\n\s*client_max_body_size\s+)[^;]+;', r'\g<1>' + limit + ';', block)
            return text[:a] + new_block + text[b:], 'already'
        ls, le, body, indent = loc
        inner = '\n'.join(line for line in body.strip('\n').split('\n'))
        new_loc = (f'{indent}{MARK} (40 MB solo aquí; el resto del API conserva su límite)\n'
                   f'{indent}location ~ {LOCATION_RE} {{\n'
                   f'{indent}    client_max_body_size {limit};\n'
                   f'{inner}\n'
                   f'{indent}}}\n\n')
        new_block = block[:ls] + new_loc + block[ls:]
        return text[:a] + new_block + text[b:], 'patched'
    return text, 'no-server'


def run(server_name, limit):
    files = sorted(set(glob.glob('/etc/nginx/sites-enabled/*') + glob.glob('/etc/nginx/conf.d/*.conf')))
    targets = []
    for f in files:
        real = os.path.realpath(f)
        try:
            text = open(real, encoding='utf-8').read()
        except OSError:
            continue
        new, state = patch(text, server_name, limit)
        if state in ('patched', 'already'):
            targets.append((real, text, new, state))
    if not targets:
        print(f'❌ No encontré un bloque server de nginx para {server_name} con proxy_pass en location /')
        return 1
    if len(targets) > 1:
        print(f'❌ {server_name} aparece en varios archivos ({", ".join(t[0] for t in targets)}): no toco nada')
        return 1
    path, old, new, state = targets[0]
    if new == old:
        print(f'✓ nginx ({path}): la lectura de documentos de {server_name} ya admite {limit}; nada que cambiar')
        return 0
    backup = f'{path}.bak-cursia86c-{int(time.time())}'
    shutil.copy2(path, backup)
    open(path, 'w', encoding='utf-8').write(new)
    t = subprocess.run(['nginx', '-t'], capture_output=True, text=True)
    if t.returncode != 0:
        shutil.copy2(backup, path)
        print('❌ nginx -t falló; restauré la configuración anterior:\n' + t.stderr)
        return 1
    r = subprocess.run(['systemctl', 'reload', 'nginx'], capture_output=True, text=True)
    if r.returncode != 0:
        shutil.copy2(backup, path)
        subprocess.run(['systemctl', 'reload', 'nginx'])
        print('❌ No se pudo recargar nginx; restauré la configuración anterior:\n' + r.stderr)
        return 1
    print(f'✓ nginx ({path}): {limit} solo en la lectura de documentos de {server_name} ({state}); copia en {backup}; nginx -t OK y recargado')
    return 0


SAMPLE = """server {
    server_name api.cursia.nomaddi.com;
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
    }
    listen 443 ssl; # managed by Certbot
}
server {
    server_name api-staging.cursia.nomaddi.com;
    # comentario con { llave }
    location / {
        proxy_pass http://localhost:3100;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_read_timeout 300s;
    }
    listen 443 ssl; # managed by Certbot
}
server {
    if ($host = api-staging.cursia.nomaddi.com) {
        return 301 https://$host$request_uri;
    }
    listen 80;
    server_name api-staging.cursia.nomaddi.com;
    return 404;
}
"""


def self_test():
    ok = True

    def expect(c, m):
        nonlocal ok
        print(('✅ ' if c else '❌ ') + m)
        ok = ok and c

    new, st = patch(SAMPLE, 'api-staging.cursia.nomaddi.com', '40m')
    expect(st == 'patched', 'agrega la location en el bloque de staging')
    blocks = find_blocks(new)
    expect(len(blocks) == 3, 'siguen 3 bloques server')
    prod, stg, redir = (new[a:b] for a, b in blocks)
    expect(prod == SAMPLE[find_blocks(SAMPLE)[0][0]:find_blocks(SAMPLE)[0][1]], 'el bloque de producción queda IDÉNTICO')
    expect(MARK not in redir and redir == SAMPLE[find_blocks(SAMPLE)[2][0]:find_blocks(SAMPLE)[2][1]], 'el redirect :80 queda idéntico')
    expect('client_max_body_size 40m;' in stg and 'proxy_pass http://localhost:3100;' in stg.split(MARK)[1].split('location / {')[0], 'la location nueva lleva 40m y el MISMO proxy_pass de staging')
    expect(stg.count('client_max_body_size') == 1, 'el límite es solo de la location nueva (no del server entero)')
    expect(stg.index(MARK) < stg.index('location / {'), 'va antes de location /')
    expect(re.match(LOCATION_RE, '/api/v1/courses/12/academic-context/extract') and re.match(LOCATION_RE, '/api/v1/courses/12/academic-context/extract-advanced/'), 'la regex cubre las dos rutas de lectura')
    expect(not re.match(LOCATION_RE, '/api/v1/courses/12/academic-context/requirements') and not re.match(LOCATION_RE, '/api/v1/courses/12/design/recommendation'), 'y no otras')
    again, st2 = patch(new, 'api-staging.cursia.nomaddi.com', '40m')
    expect(st2 == 'already' and again == new, 'idempotente: una segunda pasada no cambia nada')
    _, st3 = patch(SAMPLE, 'otro.cursia.nomaddi.com', '40m')
    expect(st3 == 'no-server', 'sin el server_name exacto no toca nada')
    bumped, _ = patch(new, 'api-staging.cursia.nomaddi.com', '50m')
    expect('client_max_body_size 50m;' in bumped and bumped.count('client_max_body_size') == 1, 'cambiar el límite actualiza la misma línea')
    return 0 if ok else 1


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--self-test':
        sys.exit(self_test())
    if len(sys.argv) != 3 or not re.match(r'^[0-9]{1,3}m$', sys.argv[2]):
        print(__doc__)
        sys.exit(2)
    if os.geteuid() != 0:
        print('❌ Correr con sudo (escribe en /etc/nginx y recarga nginx)')
        sys.exit(1)
    sys.exit(run(sys.argv[1], sys.argv[2]))
