import fs from 'node:fs';

function read(path){ return fs.readFileSync(path,'utf8'); }
function write(path, content){ fs.writeFileSync(path, content, 'utf8'); }
function replaceOnce(source, from, to, label){
  const index = source.indexOf(from);
  if(index < 0) throw new Error(`missing anchor: ${label}`);
  if(source.indexOf(from, index + from.length) >= 0) throw new Error(`non-unique anchor: ${label}`);
  return source.slice(0,index) + to + source.slice(index + from.length);
}

const indexPath = 'index.html';
let html = read(indexPath);

const cssAnchor = '\n.pendingWeatherCard{';
const css = `
.adminFoldToolbar{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin:0 0 12px}
.adminFoldToolbar button{padding:7px 11px;font-size:12px}
.adminCardFoldable>h2.adminCardFoldTitle{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}
.adminCardFoldable>h2.adminCardFoldTitle .adminCardFoldToggle{flex:0 0 auto;padding:5px 10px;font-size:12px;background:var(--soft);color:var(--accent2);border:1px solid #d7e2dc;box-shadow:none}
.adminCardFoldable.adminCardCollapsed>h2.adminCardFoldTitle{margin-bottom:0}
.adminCardFoldable.adminCardCollapsed>:not(h2){display:none!important}
.adminNativeFoldable>summary{cursor:pointer}
@media(max-width:640px){.adminFoldToolbar{justify-content:stretch}.adminFoldToolbar button{flex:1 1 0}.adminCardFoldable>h2.adminCardFoldTitle{align-items:center}.adminCardFoldable>h2.adminCardFoldTitle .adminCardFoldToggle{padding:5px 9px}}
`;
html = replaceOnce(html, cssAnchor, `\n${css}${cssAnchor}`, 'admin-fold-css');

const panelAnchor = '        <div class="adminTabPanel active" data-admin-panel="daily" role="tabpanel">';
const toolbar = `        <div class="adminFoldToolbar" aria-label="管理カードの開閉">
          <button type="button" class="secondary" id="collapseAdminCardsBtn">このタブを全部閉じる</button>
          <button type="button" class="secondary" id="expandAdminCardsBtn">このタブを全部開く</button>
        </div>\n\n`;
html = replaceOnce(html, panelAnchor, toolbar + panelAnchor, 'admin-fold-toolbar');

const setAdminUnlockedAnchor = 'function setAdminUnlocked(unlocked){';
const helpers = `const ADMIN_CARD_FOLD_STORAGE_PREFIX = "heartopia_admin_card_fold_v1:";
function adminCardFoldKey(card){
  const panel = card.closest("[data-admin-panel]")?.dataset.adminPanel || "global";
  const heading = card.querySelector(":scope > h2")?.childNodes?.[0]?.textContent?.trim()
    || card.querySelector(":scope > summary")?.textContent?.trim()
    || "card";
  return panel + ":" + heading;
}
function adminCardFoldStorageKey(card){
  return ADMIN_CARD_FOLD_STORAGE_PREFIX + encodeURIComponent(card.dataset.adminFoldKey || adminCardFoldKey(card));
}
function saveAdminCardFoldState(card, collapsed){
  try{ localStorage.setItem(adminCardFoldStorageKey(card), collapsed ? "1" : "0"); }catch(_){ }
}
function setAdminCardCollapsed(card, collapsed, persist = true){
  if(!card) return;
  if(card.matches("details")){
    card.open = !collapsed;
  }else{
    card.classList.toggle("adminCardCollapsed", collapsed);
    const toggle = card.querySelector(":scope > h2 [data-admin-card-toggle]");
    if(toggle){
      toggle.textContent = collapsed ? "開く" : "閉じる";
      toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    }
  }
  if(persist) saveAdminCardFoldState(card, collapsed);
}
function activeAdminFoldCards(){
  const panel = document.querySelector("[data-admin-panel].active");
  return panel ? [...panel.querySelectorAll(".card.s12")] : [];
}
function setActiveAdminFoldCardsCollapsed(collapsed){
  activeAdminFoldCards().forEach(card => setAdminCardCollapsed(card, collapsed));
}
function setupAdminCardFolding(){
  const cards = [...document.querySelectorAll(".adminShell > .card.s12, .adminTabPanel .card.s12")];
  cards.forEach(card => {
    card.dataset.adminFoldKey = adminCardFoldKey(card);
    if(card.matches("details")){
      card.classList.add("adminNativeFoldable");
      card.addEventListener("toggle", () => saveAdminCardFoldState(card, !card.open));
    }else{
      const heading = card.querySelector(":scope > h2");
      if(!heading) return;
      card.classList.add("adminCardFoldable");
      heading.classList.add("adminCardFoldTitle");
      if(!heading.querySelector("[data-admin-card-toggle]")){
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "adminCardFoldToggle";
        toggle.dataset.adminCardToggle = "";
        toggle.textContent = "閉じる";
        toggle.setAttribute("aria-expanded", "true");
        toggle.addEventListener("click", event => {
          event.preventDefault();
          event.stopPropagation();
          setAdminCardCollapsed(card, !card.classList.contains("adminCardCollapsed"));
        });
        heading.append(toggle);
      }
    }
    let saved = null;
    try{ saved = localStorage.getItem(adminCardFoldStorageKey(card)); }catch(_){ }
    if(saved === "1" || saved === "0") setAdminCardCollapsed(card, saved === "1", false);
  });
  document.getElementById("collapseAdminCardsBtn")?.addEventListener("click", () => setActiveAdminFoldCardsCollapsed(true));
  document.getElementById("expandAdminCardsBtn")?.addEventListener("click", () => setActiveAdminFoldCardsCollapsed(false));
}
`;
html = replaceOnce(html, setAdminUnlockedAnchor, helpers + setAdminUnlockedAnchor, 'admin-fold-helpers');

html = replaceOnce(html, '  setupAdminSubtabs();\n  setupAccessControls();', '  setupAdminSubtabs();\n  setupAdminCardFolding();\n  setupAccessControls();', 'admin-fold-init');

html = replaceOnce(
  html,
  '  if(!target) return;\n  requestAnimationFrame(() => {',
  '  if(!target) return;\n  const outerCard = target.closest(".adminCardFoldable");\n  if(outerCard) setAdminCardCollapsed(outerCard, false);\n  requestAnimationFrame(() => {',
  'pending-deeplink-expands-outer-card'
);

write(indexPath, html);

const testPath = 'tools/test-weather-admin-trigger.mjs';
let test = read(testPath);
if(!test.includes("admin cards can be collapsed")){
  test += `\n\ntest('admin cards can be collapsed to reduce long management pages', () => {\n  assert.match(index, /id=["']collapseAdminCardsBtn["']/);\n  assert.match(index, /id=["']expandAdminCardsBtn["']/);\n  assert.match(index, /function setupAdminCardFolding\\(\\)/);\n  assert.match(index, /adminCardCollapsed/);\n  assert.match(index, /setupAdminCardFolding\\(\\)/);\n  assert.match(index, /target\\.closest\\(\"\\.adminCardFoldable\"\\)/);\n});\n`;
  write(testPath, test);
}

for(const path of ['tools/tmp-admin-fold-patch.mjs', '.github/workflows/tmp-admin-fold-patch.yml']){
  try{ fs.rmSync(path); }catch(_){ }
}
