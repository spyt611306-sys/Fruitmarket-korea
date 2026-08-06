from __future__ import annotations
import json
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
checks={}
issues=[]
def check(name, condition, detail=""):
    checks[name]=bool(condition)
    if not condition: issues.append(f"{name}: {detail}")

# 1. 상품 승인 상태 전이: 미승인 또는 법정정보 미완료 상품은 판매 불가
allowed={
    "DRAFT":{"REVIEW_REQUESTED"},
    "REVIEW_REQUESTED":{"APPROVED","REJECTED"},
    "APPROVED":{"ON_SALE","REVIEW_REQUESTED","STOPPED"},
    "ON_SALE":{"STOPPED","REVIEW_REQUESTED"},
    "REJECTED":{"DRAFT","REVIEW_REQUESTED"},
    "STOPPED":{"ON_SALE","REVIEW_REQUESTED"},
}
def transition(state,target):
    if target not in allowed.get(state,set()): raise ValueError("INVALID_PRODUCT_TRANSITION")
    return target
s="DRAFT"
for t in ["REVIEW_REQUESTED","APPROVED","ON_SALE"]: s=transition(s,t)
check("상품 승인 정상 전이",s=="ON_SALE")
try: transition("DRAFT","ON_SALE"); bad=False
except ValueError: bad=True
check("상품 승인 우회 차단",bad)

def sellable(approval, sale, seller_verified, fresh_compliance, recalled=False):
    return approval=="APPROVED" and sale=="ON_SALE" and seller_verified and fresh_compliance=="APPROVED" and not recalled
check("법정정보·신선정보 미완료 판매 차단",not sellable("APPROVED","ON_SALE",True,"REVIEW_REQUIRED"))
check("리콜 로트 판매 차단",not sellable("APPROVED","ON_SALE",True,"APPROVED",True))

# 2. FEFO 로트 할당: 권장 소비기한 빠른 순, 차단/리콜 제외
lots=[
 {"id":"late","consume":"2026-08-20","available":5,"reserved":0,"qc":"PASSED","recall":"NORMAL"},
 {"id":"early","consume":"2026-08-10","available":3,"reserved":0,"qc":"PASSED","recall":"NORMAL"},
 {"id":"blocked","consume":"2026-08-08","available":9,"reserved":0,"qc":"BLOCKED","recall":"NORMAL"},
 {"id":"recalled","consume":"2026-08-09","available":9,"reserved":0,"qc":"PASSED","recall":"RECALLING"},
]
def fefo(rows,qty):
    out=[]
    for row in sorted(rows,key=lambda x:x["consume"]):
        if row["qc"] not in {"PASSED","CONDITIONAL"} or row["recall"]!="NORMAL": continue
        free=row["available"]-row["reserved"]
        take=min(qty,free)
        if take: out.append((row["id"],take));qty-=take
        if qty==0:return out
    raise ValueError("INSUFFICIENT_SAFE_STOCK")
allocation=fefo(lots,6)
check("FEFO 선출고",allocation==[("early",3),("late",3)],str(allocation))
try: fefo(lots,20); bad=False
except ValueError: bad=True
check("안전재고 부족 차단",bad)

# 3. 멱등 주문/결제 처리
@dataclass
class Ledger:
    orders:dict=field(default_factory=dict)
    payments:dict=field(default_factory=dict)
    inventory:int=10
    def prepare(self,key,qty,amount):
        if key in self.orders:return self.orders[key]
        if qty>self.inventory: raise ValueError("OUT_OF_STOCK")
        self.orders[key]={"id":"O1","qty":qty,"amount":amount,"status":"PAYMENT_PENDING"}
        return self.orders[key]
    def confirm(self,key,payment_key,amount):
        order=self.orders[key]
        if amount!=order["amount"]:raise ValueError("AMOUNT_MISMATCH")
        if payment_key in self.payments:return self.payments[payment_key]
        if order["status"]=="PAID":return self.payments[next(iter(self.payments))]
        self.inventory-=order["qty"];order["status"]="PAID"
        self.payments[payment_key]={"status":"DONE","amount":amount}
        return self.payments[payment_key]
ledger=Ledger();a=ledger.prepare("K1",2,30000);b=ledger.prepare("K1",2,30000)
check("주문 준비 멱등",a is b and len(ledger.orders)==1)
ledger.confirm("K1","P1",30000);ledger.confirm("K1","P1",30000)
check("결제 승인 멱등",ledger.inventory==8 and len(ledger.payments)==1)
try: Ledger().prepare("K2",2,30000); tmp=Ledger(); tmp.prepare("K2",2,30000);tmp.confirm("K2","P2",29999);bad=False
except ValueError:bad=True
check("결제 금액변조 차단",bad)

# 4. 판매자별 주문 분리/배송 추적
cart=[{"seller":"S1","subtotal":20000},{"seller":"S2","subtotal":10000},{"seller":"S1","subtotal":5000}]
groups={}
for line in cart:groups.setdefault(line["seller"],0);groups[line["seller"]]+=line["subtotal"]
check("판매자별 주문그룹",groups=={"S1":25000,"S2":10000},str(groups))
shipping_allowed={"READY":{"PREPARING","CANCELED"},"PREPARING":{"SHIPPED","CANCELED"},"SHIPPED":{"IN_TRANSIT","DELIVERED"},"IN_TRANSIT":{"DELIVERED"},"DELIVERED":set()}
state="READY"
for target in ["PREPARING","SHIPPED","IN_TRANSIT","DELIVERED"]:
    check(f"배송전이 {state}->{target}",target in shipping_allowed[state]);state=target

# 5. 신선식품 품질 클레임/환불/정산
@dataclass
class Settlement:
    gross:int
    fee:int
    refunds:int=0
    adjustments:int=0
    reserve:int=0
    def payable(self):return self.gross-self.fee-self.refunds+self.adjustments-self.reserve
settlement=Settlement(gross=100000,fee=10000,refunds=20000,adjustments=-1000,reserve=5000)
check("정산 산식",settlement.payable()==64000,str(settlement.payable()))
check("환불액이 정산에서 차감",Settlement(50000,5000,10000).payable()==35000)

# 6. 분쟁 SLA 영업일 계산(주말 제외)
def add_business_days(start,days):
    current=start;added=0
    while added<days:
        current+=timedelta(days=1)
        if current.weekday()<5:added+=1
    return current
fri=datetime(2026,8,7,tzinfo=timezone.utc)
check("3영업일 SLA",add_business_days(fri,3).date().isoformat()=="2026-08-12",str(add_business_days(fri,3)))
check("10영업일 SLA",add_business_days(fri,10).date().isoformat()=="2026-08-21",str(add_business_days(fri,10)))

# 7. 리콜 구매자 통지 대상 추출
allocations=[{"lot":"L1","buyer":"U1"},{"lot":"L2","buyer":"U2"},{"lot":"L1","buyer":"U3"},{"lot":"L1","buyer":"U1"}]
targets=sorted({x["buyer"] for x in allocations if x["lot"]=="L1"})
check("리콜 구매자 중복제거 통지",targets==["U1","U3"],str(targets))

# 8. 버튼 중복 실행 차단 모델
class ButtonGuard:
    def __init__(self):self.pending=False;self.calls=0
    def click(self):
        if self.pending:return False
        self.pending=True;self.calls+=1;return True
    def finish(self):self.pending=False
guard=ButtonGuard();first=guard.click();second=guard.click();guard.finish();third=guard.click()
check("버튼 연속클릭 중복차단",first and not second and third and guard.calls==2)

result={"checkedAt":datetime.now(timezone.utc).isoformat(),"checks":checks,"issues":issues,"passed":not issues}
(ROOT/"tests/PART46-PROCESS-SIMULATION.json").write_text(json.dumps(result,ensure_ascii=False,indent=2),"utf-8")
print(json.dumps(result,ensure_ascii=False,indent=2))
raise SystemExit(0 if result["passed"] else 1)
