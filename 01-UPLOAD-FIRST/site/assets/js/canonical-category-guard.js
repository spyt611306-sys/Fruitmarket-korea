(function (global) {
  "use strict";
  const names = Object.freeze(["전체","사과","바나나","블루베리","체리","무화과","자몽","포도","키위","레몬","감귤","망고","멜론","참외","복숭아","배","감","파인애플","자두","석류","딸기","수박"]);
  function ensureCanonicalFruitCategories() {
    const db = global.liveState;
    if (!db || !global.app) return false;
    const current = Array.isArray(db.categories) ? db.categories.filter(Boolean) : [];
    if (current.length < 2) db.categories = [...names];
    global.app.syncCategorySelectors?.();
    const route = location.hash.replace(/^#/, "").split("/")[0] || "home";
    if (route === "home") global.app.renderHome?.();
    else if (route === "list") global.app.renderList?.();
    document.documentElement.dataset.fruitCategoryGuard = "ready";
    return true;
  }
  const run = () => {
    if (!ensureCanonicalFruitCategories()) setTimeout(run, 50);
  };
  global.addEventListener("fruitmarket:data-loaded", run);
  global.addEventListener("DOMContentLoaded", run, { once: true });
  global.addEventListener("load", () => {
    run();
    setTimeout(run, 250);
    setTimeout(run, 1000);
  }, { once: true });
  run();
})(window);
