(function(){
"use strict";
const btn=document.getElementById("fm-kakao-share");
if(!btn)return;
btn.addEventListener("click",async()=>{
 const data={title:"푸릇마켓 | 산지에서 바로 만나는 신선한 과일",text:"제철 과일을 믿을 수 있는 생산자에게 직접 구매하세요.",url:location.origin+"/"};
 try{if(navigator.share){await navigator.share(data);return;} await navigator.clipboard.writeText(data.url); alert("링크를 복사했습니다. 카카오톡에 붙여넣어 공유해 주세요.");}
 catch(e){if(e&&e.name!=="AbortError") alert("공유하지 못했습니다. 잠시 후 다시 시도해 주세요.");}
});
})();
