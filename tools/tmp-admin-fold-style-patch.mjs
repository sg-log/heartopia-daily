import fs from 'node:fs';

const path = 'index.html';
let s = fs.readFileSync(path, 'utf8');

function replaceOrFail(oldText, newText, label){
  if(!s.includes(oldText)) throw new Error(`${label} not found`);
  s = s.replace(oldText, newText);
}

replaceOrFail(`.adminFoldToolbar{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin:0 0 12px}
.adminFoldToolbar button{padding:7px 11px;font-size:12px}
.adminCardFoldable>h2.adminCardFoldTitle{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}
.adminCardFoldable>h2.adminCardFoldTitle .adminCardFoldToggle{flex:0 0 auto;padding:5px 10px;font-size:12px;background:var(--soft);color:var(--accent2);border:1px solid #d7e2dc;box-shadow:none}
.adminCardFoldable.adminCardCollapsed>h2.adminCardFoldTitle{margin-bottom:0}
.adminCardFoldable.adminCardCollapsed>:not(h2){display:none!important}
.adminNativeFoldable>summary{cursor:pointer}
@media(max-width:640px){.adminFoldToolbar{justify-content:stretch}.adminFoldToolbar button{flex:1 1 0}.adminCardFoldable>h2.adminCardFoldTitle{align-items:center}.adminCardFoldable>h2.adminCardFoldTitle .adminCardFoldToggle{padding:5px 9px}}
`, `.adminFoldToolbar{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0 0 2px}
.adminFoldToolbar button{width:100%;padding:8px 12px;font-size:12px}
.adminCardFoldable>h2.adminCardFoldTitle{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;cursor:pointer;user-select:none}
.adminCardFoldable>h2.adminCardFoldTitle::after{content:"−";flex:0 0 auto;font-size:22px;font-weight:500;line-height:1;color:var(--accent2)}
.adminCardFoldable.adminCardCollapsed>h2.adminCardFoldTitle{margin-bottom:0}
.adminCardFoldable.adminCardCollapsed>h2.adminCardFoldTitle::after{content:"＋"}
.adminCardFoldable.adminCardCollapsed>:not(h2){display:none!important}
.adminNativeFoldable>summary{display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;list-style:none;user-select:none}
.adminNativeFoldable>summary::-webkit-details-marker{display:none}
.adminNativeFoldable>summary::after{content:"＋";flex:0 0 auto;font-size:22px;font-weight:500;line-height:1;color:var(--accent2)}
.adminNativeFoldable[open]>summary::after{content:"−"}
`, 'fold CSS');

replaceOrFail(`        <div class="adminFoldToolbar" aria-label="管理カードの開閉">
          <button type="button" class="secondary" id="collapseAdminCardsBtn">このタブを全部閉じる</button>
          <button type="button" class="secondary" id="expandAdminCardsBtn">このタブを全部開く</button>
        </div>

`, '', 'old toolbar');

const toolbar = `          <div class="adminFoldToolbar" aria-label="このタブのカードを開閉">
            <button type="button" class="secondary" data-admin-collapse-all>全部閉じる</button>
            <button type="button" class="secondary" data-admin-expand-all>全部開く</button>
          </div>
`;
for(const marker of [
  '        <div class="adminTabPanel active" data-admin-panel="daily" role="tabpanel">\n',
  '        <div class="adminTabPanel" data-admin-panel="manage" role="tabpanel">\n',
  '        <div class="adminTabPanel" data-admin-panel="data" role="tabpanel">\n'
]){
  replaceOrFail(marker, marker + toolbar, `panel ${marker}`);
}

replaceOrFail(`function setAdminCardCollapsed(card, collapsed, persist = true){
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
`, `function setAdminCardCollapsed(card, collapsed, persist = true){
  if(!card) return;
  if(card.matches("details")){
    card.open = !collapsed;
  }else{
    card.classList.toggle("adminCardCollapsed", collapsed);
    const heading = card.querySelector(":scope > h2.adminCardFoldTitle");
    if(heading) heading.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }
  if(persist) saveAdminCardFoldState(card, collapsed);
}
`, 'setAdminCardCollapsed');

replaceOrFail(`    }else{
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
`, `    }else{
      const heading = card.querySelector(":scope > h2");
      if(!heading) return;
      card.classList.add("adminCardFoldable");
      heading.classList.add("adminCardFoldTitle");
      heading.setAttribute("role", "button");
      heading.setAttribute("tabindex", "0");
      heading.setAttribute("aria-expanded", "true");
      const toggleCard = () => setAdminCardCollapsed(card, !card.classList.contains("adminCardCollapsed"));
      heading.addEventListener("click", toggleCard);
      heading.addEventListener("keydown", event => {
        if(event.key === "Enter" || event.key === " "){
          event.preventDefault();
          toggleCard();
        }
      });
    }
`, 'setup card toggles');

replaceOrFail(`  document.getElementById("collapseAdminCardsBtn")?.addEventListener("click", () => setActiveAdminFoldCardsCollapsed(true));
  document.getElementById("expandAdminCardsBtn")?.addEventListener("click", () => setActiveAdminFoldCardsCollapsed(false));
`, `  document.querySelectorAll("[data-admin-collapse-all]").forEach(button => button.addEventListener("click", () => setActiveAdminFoldCardsCollapsed(true)));
  document.querySelectorAll("[data-admin-expand-all]").forEach(button => button.addEventListener("click", () => setActiveAdminFoldCardsCollapsed(false)));
`, 'toolbar events');

fs.writeFileSync(path, s);

const testPath = 'tools/test-weather-admin-trigger.mjs';
let t = fs.readFileSync(testPath, 'utf8');
t = t.replace(/assert\.match\(index, \/id=\[\\"'\]collapseAdminCardsBtn\[\\"'\]\/[\s\S]*?assert\.match\(index, \/id=\[\\"'\]expandAdminCardsBtn\[\\"'\]\//, `assert.match(index, /data-admin-collapse-all/);\n  assert.match(index, /data-admin-expand-all/)`);
fs.writeFileSync(testPath, t);
