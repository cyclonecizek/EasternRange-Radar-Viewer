#!/usr/bin/env python3
"""Assemble docs/index.html (one self-contained file) from src/. Usage: python build.py"""
import pathlib, sys
root = pathlib.Path(__file__).parent; src = root / 'src'
three = (root / 'vendor' / 'three.min.js').read_text(encoding='utf-8')
app = '\n'.join((src / f).read_text(encoding='utf-8') for f in ['core.js', 'io.js', 'colors.js', 'basemap.js', 'mctables.js', 'app1.js', 'app2.js', 'app3.js', 'view3d.js', 'main.js'])
html = (src / 'index.tpl.html').read_text(encoding='utf-8')
for tag, body in (('/*THREE*/', three), ('/*DECODER*/', (src / 'decoder.js').read_text(encoding='utf-8')), ('/*APP*/', app)):
    assert '</script' not in body.lower(), tag + ' contains a closing script tag'
    html = html.replace(tag, body)
(root / 'docs').mkdir(exist_ok=True); (root / 'docs' / 'index.html').write_text(html, encoding='utf-8')
print('wrote docs/index.html', round(len(html) / 1024), 'kB')
