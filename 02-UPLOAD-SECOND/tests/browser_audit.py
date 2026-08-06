from __future__ import annotations
import json, mimetypes, re
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
SITE=ROOT/'site'
RESULT=ROOT/'tests/browser-audit-results.json'


def test_html():
    html=(SITE/'index.html').read_text('utf-8')
    html=re.sub(r'<meta\s+content="[^"]*"\s+http-equiv="Content-Security-Policy"\s*/?>','',html,count=1,flags=re.I)
    html=html.replace('<head>','<head><base href="http://assets.test/">',1)
    return html


def run():
    result={'viewports':{},'testMode':'page.set_content with CSP meta removed only because the execution environment blocks localhost; CSP hash completeness is tested separately','passed':False}
    with sync_playwright() as p:
        launch_args={'headless':True,'args':['--no-sandbox']}
        if Path('/usr/bin/chromium').exists(): launch_args['executable_path']='/usr/bin/chromium'
        browser=p.chromium.launch(**launch_args)
        for width,height in [(390,844),(1365,900)]:
            context=browser.new_context(viewport={'width':width,'height':height})
            errors=[]; failed=[]
            def route_all(route):
                url=urlparse(route.request.url)
                if url.netloc=='assets.test':
                    rel=url.path.lstrip('/')
                    file=(SITE/rel).resolve()
                    if not file.is_file():
                        failed.append('missing-local:'+route.request.url)
                        return route.fulfill(status=404,body='not found')
                    return route.fulfill(status=200,body=file.read_bytes(),content_type=mimetypes.guess_type(file.name)[0] or 'application/octet-stream')
                if url.netloc=='cdn.jsdelivr.net':
                    return route.fulfill(status=200,content_type='application/javascript',body='window.supabase={createClient(){return {}}};')
                if url.netloc in {'t1.kakaocdn.net','postcode.map.kakao.com','postcode.map.daum.net'}:
                    return route.fulfill(status=200,content_type='application/javascript',body='window.daum={Postcode:function(){this.open=function(){};this.embed=function(){}}};')
                if url.netloc=='js.tosspayments.com':
                    return route.fulfill(status=200,content_type='application/javascript',body='window.TossPayments=function(){return {widgets(){return {}}}};')
                return route.abort()
            context.route('**/*',route_all)
            page=context.new_page()
            page.on('pageerror',lambda e:errors.append(str(e)))
            page.on('console',lambda m: errors.append(f'console:{m.text}') if m.type=='error' else None)
            page.on('requestfailed',lambda r: failed.append(f'{r.url}:{r.failure}'))
            page.set_content(test_html(),wait_until='domcontentloaded',timeout=60000)
            page.wait_for_timeout(1800)
            banner_count=page.locator('#home-hero-track .hero-slide').count()
            initial=page.locator('#home-hero-counter').inner_text() if page.locator('#home-hero-counter').count() else ''
            first_src=page.locator('#home-hero-track img').first.get_attribute('src') if page.locator('#home-hero-track img').count() else ''
            page.wait_for_timeout(3300)
            after=page.locator('#home-hero-counter').inner_text() if page.locator('#home-hero-counter').count() else ''
            icon_count=page.locator('#home-category-quick-box img').count()
            icon_srcs=page.locator('#home-category-quick-box img').evaluate_all('els=>els.map(x=>x.getAttribute("src"))') if icon_count else []
            address_text=page.locator('body').inner_text()
            overflow=page.evaluate('document.documentElement.scrollWidth-document.documentElement.clientWidth')
            status=page.locator('#home-hero-carousel').get_attribute('data-hero-autoplay') if page.locator('#home-hero-carousel').count() else None
            ready=page.locator('html').get_attribute('data-fruitmarket-ready')
            part46_ready=page.locator('html').get_attribute('data-fruitmarket-part46')
            part46_panels={key:page.locator(f'#{key}').count() for key in ['fm46-seller-fresh-center','fm46-buyer-disputes','fm46-admin-marketplace-center','fm46-checkout-notice','fm46-platform-footer']}
            ui_audit=page.evaluate('window.FRUITMARKET_PART46_UI_AUDIT || null')
            part48_ready=page.locator('html').get_attribute('data-fruitmarket-part48')
            part48_panels={key:page.locator(f'#{key}').count() for key in ['fm48-buyer-protection','fm48-seller-protection','fm48-admin-protection']}
            part48_audit=page.evaluate('window.FRUITMARKET_PART48_PROTECTION_AUDIT || null')
            result['viewports'][str(width)]={
                'bannerCount':banner_count,'initialCounter':initial,'afterCounter':after,
                'autoplayMoved':initial!=after,'autoplayStatus':status,'firstBannerSrc':first_src,
                'fruitIconCount':icon_count,'fruitIconFileCount':sum(1 for x in icon_srcs if x and 'assets/fruit-icons/' in x),
                'unitNumberAbsent':'606호' not in address_text,'appReady':ready,'part46Ready':part46_ready,
                'part46Panels':part46_panels,'part46UiAudit':ui_audit,
                'part48Ready':part48_ready,'part48Panels':part48_panels,'part48Audit':part48_audit,
                'overflow':overflow,'errors':errors,'failedRequests':failed
            }
            context.close()
        browser.close()
    checks=[]
    for v in result['viewports'].values():
        checks += [v['bannerCount']==3,v['autoplayMoved'],v['autoplayStatus']=='running',v['firstBannerSrc'].endswith('assets/banners/home-hero-01.webp'),v['fruitIconCount']>=20,v['fruitIconFileCount']>=20,v['unitNumberAbsent'],v['appReady']=='true',v['part46Ready']=='ready',all(n==1 for n in v['part46Panels'].values()),not (v['part46UiAudit'] or {}).get('duplicateIds'),v['part48Ready']=='ready',all(n==1 for n in v['part48Panels'].values()),not (v['part48Audit'] or {}).get('duplicateIds'),v['overflow']==0,not v['errors']]
    result['passed']=all(checks)
    RESULT.write_text(json.dumps(result,ensure_ascii=False,indent=2),'utf-8')
    print(json.dumps(result,ensure_ascii=False,indent=2))
    raise SystemExit(0 if result['passed'] else 1)

if __name__=='__main__': run()
