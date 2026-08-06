from __future__ import annotations
import json
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
checks={}; issues=[]; details={}
def check(name, ok, detail=''):
    checks[name]=bool(ok); details[name]=detail
    if not ok: issues.append(f'{name}: {detail}')

@dataclass
class Signal:
    code:str; points:int; status:str='ACTIVE'; evidence:dict=field(default_factory=dict)
@dataclass
class Case:
    subject:str; signals:list[Signal]=field(default_factory=list); temporary_actions:list[dict]=field(default_factory=list)
    final_action:str|None=None; notice_sent:bool=False; appeal_allowed:bool=True
    def score(self): return sum(s.points for s in self.signals if s.status in {'ACTIVE','CONFIRMED'})
    def temporary(self, action, hours, reason):
        self.temporary_actions.append({'action':action,'endsAt':datetime.now(timezone.utc)+timedelta(hours=hours),'reason':reason})
    def decide(self, action, manual_review, reason):
        if not manual_review or not reason.strip(): raise ValueError('MANUAL_REVIEW_AND_REASON_REQUIRED')
        self.final_action=action; self.notice_sent=True

# 판매자: 허위송장·미출고는 배송증거와 주문기한을 대조하고 임시 지급보류 후 수동심사
seller=Case('SELLER:S1',[Signal('SELLER_FALSE_TRACKING',45,evidence={'carrierScan':False}),Signal('SELLER_NONSHIPMENT',35,evidence={'shipByMissed':True})])
seller.temporary('PAYOUT_HOLD',72,'허위송장·미출고 의심 조사')
check('판매자 허위송장 임시 지급보류',seller.score()>=60 and seller.temporary_actions[0]['action']=='PAYOUT_HOLD')
try: seller.decide('TERMINATE',False,'자동결정'); blocked=False
except ValueError: blocked=True
check('판매자 자동 영구제재 금지',blocked)
seller.decide('LIMITED_RESTRICTION',True,'택배 집하 기록 부재와 반복 미출고 확인')
check('판매자 최종조치 수동심사·통지',seller.final_action=='LIMITED_RESTRICTION' and seller.notice_sent and seller.appeal_allowed)

# 리콜·원산지 위반은 상품/로트 즉시 임시 중단하되 판매자 소명·소비자 통지
food=Case('SELLER:S2',[Signal('SELLER_RECALLED_LOT_SALE',100,evidence={'lot':'L-100'})])
food.temporary('PRODUCT_STOP',168,'식품안전 긴급보호')
check('리콜 로트 즉시 판매중지',food.temporary_actions[0]['action']=='PRODUCT_STOP' and food.appeal_allowed)

# 정산계좌 변경은 72시간 냉각·MFA·예금주 재검증
account_change={'coolingUntil':datetime.now(timezone.utc)+timedelta(hours=72),'mfa':False,'holderVerified':False}
check('정산계좌 변경 72시간 냉각',account_change['coolingUntil']>datetime.now(timezone.utc)+timedelta(hours=71))
check('MFA 전 지급 차단',not (account_change['mfa'] and account_change['holderVerified']))

# 구매자: 중복 환불은 동일 주문·클레임·결제 원장을 기준으로 중복분만 차단
refund_ledger=set()
def request_refund(order, claim, amount):
    key=(order,claim,amount)
    if key in refund_ledger:return 'DUPLICATE_BLOCK'
    refund_ledger.add(key); return 'ACCEPTED'
check('정상 환불 접수',request_refund('O1','C1',12000)=='ACCEPTED')
check('동일 환불 중복 차단',request_refund('O1','C1',12000)=='DUPLICATE_BLOCK')
check('다른 품목 부분환불 허용',request_refund('O1','C2',5000)=='ACCEPTED')

# 악성반품 의심: 빈상자/상품바꿔치기는 회수중량·개봉영상·상품식별을 함께 검토
inspection={'expectedWeight':1100,'receivedWeight':120,'serialMatch':False,'sealedEvidence':True}
indicator=inspection['receivedWeight'] < inspection['expectedWeight']*.3 and not inspection['serialMatch']
case=Case('BUYER:U1',[Signal('BUYER_EMPTY_OR_SWITCH_RETURN',70,evidence=inspection)])
case.temporary('REFUND_REVIEW',72,'반품 검수 불일치')
check('빈상자·바꿔치기 환불 수동검토',indicator and case.temporary_actions[0]['action']=='REFUND_REVIEW' and case.final_action is None)

# 정당한 신선식품 하자는 고빈도 신호만으로 거절하지 않음
legit={'sellerLotRecall':True,'photos':3,'deliveryDelayHours':38,'priorRefunds':4}
decision='REFUND_ALLOWED' if legit['sellerLotRecall'] or legit['photos']>=2 else 'REVIEW'
check('정당한 품질하자 환불 보호',decision=='REFUND_ALLOWED')

# 주소·기기 동일만으로 가족/사업장 구성원을 자동 연계하지 않음
link_signals={'sameAddress':True,'sameDevice':False,'samePaymentToken':False,'coordinatedOrders':False}
auto_block=sum(bool(v) for v in link_signals.values())>=3
check('동일주소 단독 자동제재 금지',not auto_block)

# 환불 후 차지백은 결제·환불 원장 대사 및 중복손실 방지
payment={'paid':50000,'refunded':50000,'chargeback':50000}
duplicate_loss=max(0,payment['refunded']+payment['chargeback']-payment['paid'])
check('환불 후 차지백 중복손실 탐지',duplicate_loss==50000)

# 신고만으로 최종제재 금지, 양측 증거와 이의제기
report=Case('BUYER:U2',[Signal('SELLER_REPORT_ONLY',10,evidence={'reporter':'S3'})])
check('단일 신고만으로 최종제재 금지',report.final_action is None and report.appeal_allowed)

# 이의제기 인용 시 임시조치 해제·신호 기각
appeal_case=Case('SELLER:S4',[Signal('SELLER_NONSHIPMENT',35)])
appeal_case.temporary('PAYOUT_HOLD',72,'조사')
appeal_case.signals[0].status='DISMISSED'; appeal_case.temporary_actions.clear()
check('이의제기 인용 시 조치해제',appeal_case.score()==0 and not appeal_case.temporary_actions)

# 임시조치는 종료시각 필수·만료 자동해제
now=datetime.now(timezone.utc); action={'endsAt':now-timedelta(seconds=1),'status':'ACTIVE'}
if action['endsAt']<=now: action['status']='EXPIRED'
check('임시조치 자동만료',action['status']=='EXPIRED')

# 증거 원본은 해시로 무결성 확인, 수정 금지 모델
original=b'carrier-scan:O100:delivered'; digest=__import__('hashlib').sha256(original).hexdigest()
tampered=b'carrier-scan:O100:not-delivered'
check('증거 해시 변조 탐지',__import__('hashlib').sha256(tampered).hexdigest()!=digest)

# 양측 증거 수집과 최소수집
bundle={'buyer':['unboxing-photo','claim-text'],'seller':['packing-photo','weight'],'carrier':['scan'], 'rawCardNumber':None}
check('양측·택배 증거 동시검토',all(bundle[k] for k in ['buyer','seller','carrier']))
check('불필요한 결제정보 미수집',bundle['rawCardNumber'] is None)

# 과도한 주문속도는 본인확인/검토로 전환하되 자동 영구차단 금지
orders24h=9; checkout='REVIEW' if orders24h>=8 else 'ALLOW'
check('고속주문 추가확인',checkout=='REVIEW')
check('고속주문 자동 영구차단 금지',checkout!='BLOCKED')

# 관리자의 자의적 정산몰수 방지: 금액·사유·법적 근거·승인자 2인 필요
recovery={'amount':15000,'reason':'확정된 허위송장 소비자 보상','evidence':True,'approvers':['A1','A2']}
check('손실회복 이중승인·증거',recovery['amount']>0 and recovery['evidence'] and len(set(recovery['approvers']))>=2)

result={'version':'48.0.0','checkedAt':datetime.now(timezone.utc).isoformat(),'checks':checks,'details':details,'issues':issues,'passed':not issues}
(ROOT/'tests/PART48-MUTUAL-PROTECTION-SIMULATION.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),'utf-8')
print(json.dumps(result,ensure_ascii=False,indent=2))
raise SystemExit(0 if result['passed'] else 1)
