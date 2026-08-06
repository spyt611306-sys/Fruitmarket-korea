(()=>{
'use strict';
if(window.__MATCHSIK_CALENDAR_FIT_V281__)return;window.__MATCHSIK_CALENDAR_FIT_V281__=true;
function patch(root=document){
 const candidates=root.querySelectorAll?.('.calendar-grid,.class-calendar-grid,.calendar-days,.student-calendar,[data-calendar-grid],[data-student-calendar]')||[];
 candidates.forEach((grid)=>{
   grid.classList.add('m28-month-calendar');
   const children=[...grid.children];
   if(children.length>=7){grid.style.display='grid';grid.style.gridTemplateColumns='repeat(7,minmax(0,1fr))';grid.style.width='100%';grid.style.minWidth='0';grid.style.overflow='visible'}
   children.forEach((cell)=>cell.classList.add('m28-calendar-day'));
   grid.closest('.calendar-shell,.class-calendar-shell,.student-calendar-shell,.calendar-wrap,.calendar-container')?.style.setProperty('overflow-x','hidden','important');
 });
 document.querySelectorAll('.calendar-weekdays,[data-calendar-weekdays]').forEach((row)=>{row.classList.add('m28-calendar-weekdays');row.style.gridTemplateColumns='repeat(7,minmax(0,1fr))'});
}
let queued=false;const schedule=()=>{if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;patch()})};
new MutationObserver(schedule).observe(document.documentElement,{childList:true,subtree:true});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',patch);else patch();
})();
