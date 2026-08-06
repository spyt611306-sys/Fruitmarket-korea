from pathlib import Path
import re, hashlib, base64

root=Path(__file__).resolve().parents[1]
p=root/'site/index.html'
text=p.read_text('utf-8')
hashes=[]
for match in re.finditer(r'<script\b([^>]*)>(.*?)</script\s*>', text, re.I|re.S):
    attrs,code=match.group(1),match.group(2)
    if re.search(r'\bsrc\s*=',attrs,re.I) or not code.strip():
        continue
    digest=base64.b64encode(hashlib.sha256(code.encode('utf-8')).digest()).decode()
    item=f"'sha256-{digest}'"
    if item not in hashes: hashes.append(item)
script_src="script-src 'self' https://t1.kakaocdn.net https://cdn.jsdelivr.net https://js.tosspayments.com " + ' '.join(hashes)
new_text,count=re.subn(r"script-src\s+.*?;\s*style-src",script_src+"; style-src",text,count=1,flags=re.S)
if count!=1: raise SystemExit('CSP script-src not found')
p.write_text(new_text,'utf-8')
print({'inline':len(hashes),'updated':True})
