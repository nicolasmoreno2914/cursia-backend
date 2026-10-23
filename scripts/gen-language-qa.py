#!/usr/bin/env python3
"""Regenera src/modules/language-qa/language-qa.ts desde el frontend (src/js/55-language-qa.js).
Uso: python3 scripts/gen-language-qa.py <ruta-frontend>"""
import re, sys, os
fe = sys.argv[1]
src = open(os.path.join(fe, 'src/js/55-language-qa.js'), encoding='utf8').read()
body = src[:src.index("if (typeof module !== 'undefined'")].rstrip() + "\n"
body = re.sub(r'^var (\w+)', r'export const \1', body, flags=re.M)
body = re.sub(r'^function (lqa\w+)', r'export function \1', body, flags=re.M)
header = open(os.path.join(os.path.dirname(__file__), '..', 'src/modules/language-qa/language-qa.ts'), encoding='utf8').read().split('\n')[:5]
open(os.path.join(os.path.dirname(__file__), '..', 'src/modules/language-qa/language-qa.ts'), 'w', encoding='utf8').write('\n'.join(header) + '\n' + body)
