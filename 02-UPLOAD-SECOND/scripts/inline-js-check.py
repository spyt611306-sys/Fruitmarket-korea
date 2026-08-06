from __future__ import annotations
import json, subprocess, tempfile
from pathlib import Path
from bs4 import BeautifulSoup

ROOT=Path(__file__).resolve().parents[1]
HTML=ROOT/'site/index.html'
soup=BeautifulSoup(HTML.read_text('utf-8'),'html.parser')
results=[]
for index, script in enumerate(soup.find_all('script')):
    if script.get('src'): continue
    code=script.string if script.string is not None else script.get_text()
    if not code.strip(): continue
    with tempfile.NamedTemporaryFile('w',encoding='utf-8',suffix='.js',delete=False) as tmp:
        tmp.write(code); name=tmp.name
    proc=subprocess.run(['node','--check',name],text=True,capture_output=True)
    Path(name).unlink(missing_ok=True)
    results.append({
        'index':index,
        'source':script.get('data-integrated-source') or script.get('id') or f'inline-{index}',
        'ok':proc.returncode==0,
        'error':proc.stderr.strip()
    })
failed=[row for row in results if not row['ok']]
out={'inlineScriptCount':len(results),'failedCount':len(failed),'failed':failed,'passed':not failed}
(ROOT/'tests/inline-js-results.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),'utf-8')
print(json.dumps(out,ensure_ascii=False,indent=2))
raise SystemExit(0 if out['passed'] else 1)
