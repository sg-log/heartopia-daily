(() => {
  "use strict";

  const STYLE_ID = "heartopiaPendingReviewUiStyle";
  const MODAL_ID = "pendingWeatherImageModal";
  let lastFocus = null;

  function injectStyles(){
    if(document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .pendingWeatherToggle{
        width:100%;display:flex;align-items:center;justify-content:space-between;gap:12px;
        padding:2px 0;border:0;border-radius:8px;background:transparent;color:var(--heading);
        text-align:left;box-shadow:none;font-weight:800;
      }
      .pendingWeatherToggle:hover{background:rgba(124,145,137,.07)}
      .pendingWeatherToggleMain{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
      .pendingWeatherToggleTitle{font-size:14px;font-weight:900;color:var(--heading)}
      .pendingWeatherBadge{
        display:inline-flex;align-items:center;min-height:24px;padding:3px 8px;border-radius:999px;
        border:1px solid #d7e2dc;background:var(--soft);color:var(--accent2);
        font-size:11px;font-weight:800;white-space:nowrap;
      }
      .pendingWeatherBadge.noEvidence{background:#f7f4ef;border-color:var(--line);color:var(--muted)}
      .pendingWeatherChevron{flex:0 0 auto;font-size:20px;line-height:1;color:var(--accent2);transition:transform .18s ease}
      .pendingWeatherToggle[aria-expanded="true"] .pendingWeatherChevron{transform:rotate(180deg)}
      .pendingWeatherBody{padding-top:10px}
      .pendingWeatherBody[hidden]{display:none!important}
      .pendingWeatherImageOpen{
        display:flex;flex-direction:column;align-items:flex-start;gap:4px;max-width:100%;
        padding:0;border:0;border-radius:8px;background:transparent;color:var(--accent2);
        font:inherit;font-weight:800;text-align:left;box-shadow:none;
      }
      .pendingWeatherImageOpen:hover{background:rgba(124,145,137,.07)}
      .pendingWeatherImageOpen img{display:block}
      body.pendingWeatherModalOpen{overflow:hidden}
      .pendingWeatherImageModal[hidden]{display:none!important}
      .pendingWeatherImageModal{
        position:fixed;inset:0;z-index:10000;background:rgba(25,22,20,.90);
        display:grid;place-items:center;padding:max(14px,env(safe-area-inset-top)) 14px max(14px,env(safe-area-inset-bottom));
      }
      .pendingWeatherImageModalPanel{
        width:min(1200px,100%);height:min(92vh,100%);position:relative;display:flex;
        align-items:center;justify-content:center;overflow:auto;overscroll-behavior:contain;
        -webkit-overflow-scrolling:touch;touch-action:pinch-zoom;
      }
      .pendingWeatherImageModal img{
        display:block;max-width:100%;max-height:88vh;width:auto;height:auto;object-fit:contain;
        background:#fff;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.35);
      }
      .pendingWeatherImageModalClose{
        position:fixed;top:max(12px,env(safe-area-inset-top));right:14px;z-index:10001;
        width:44px;height:44px;padding:0;border-radius:999px;background:rgba(255,255,255,.95);
        color:#3f3a36;border:1px solid rgba(255,255,255,.4);font-size:24px;line-height:1;box-shadow:0 4px 20px rgba(0,0,0,.22);
      }
      @media(max-width:640px){
        .pendingWeatherToggleTitle{font-size:13px}
        .pendingWeatherToggleMain{gap:6px}
        .pendingWeatherBody{padding-top:8px}
        .pendingWeatherImageModal{padding:8px}
        .pendingWeatherImageModalPanel{height:94vh}
        .pendingWeatherImageModal img{max-height:90vh;border-radius:6px}
      }
    `;
    document.head.appendChild(style);
  }

  function safeImageUrl(value){
    const text = String(value || "").trim();
    if(!text) return "";
    if(text.startsWith("blob:")) return text;
    try{
      const url = new URL(text, location.href);
      if(!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
      return url.href;
    }catch(_){
      return "";
    }
  }

  function ensureModal(){
    let modal = document.getElementById(MODAL_ID);
    if(modal) return modal;
    modal = document.createElement("div");
    modal.id = MODAL_ID;
    modal.className = "pendingWeatherImageModal";
    modal.hidden = true;
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "証拠画像の拡大表示");
    modal.innerHTML = `
      <button type="button" class="pendingWeatherImageModalClose" aria-label="拡大画像を閉じる">×</button>
      <div class="pendingWeatherImageModalPanel"><img alt="証拠画像の拡大"></div>
    `;
    modal.addEventListener("click", event => {
      if(event.target === modal || event.target.classList.contains("pendingWeatherImageModalPanel") || event.target.closest(".pendingWeatherImageModalClose")) closeImage();
    });
    document.body.appendChild(modal);
    return modal;
  }

  function openImage(value, alt="証拠画像"){
    const src = safeImageUrl(value);
    if(!src) return;
    const modal = ensureModal();
    const image = modal.querySelector("img");
    lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    image.src = src;
    image.alt = alt || "証拠画像";
    modal.hidden = false;
    document.body.classList.add("pendingWeatherModalOpen");
    modal.querySelector(".pendingWeatherImageModalClose")?.focus();
  }

  function closeImage(){
    const modal = document.getElementById(MODAL_ID);
    if(!modal || modal.hidden) return;
    modal.hidden = true;
    modal.querySelector("img")?.removeAttribute("src");
    document.body.classList.remove("pendingWeatherModalOpen");
    if(lastFocus?.isConnected) lastFocus.focus();
    lastFocus = null;
  }

  function deepLinkId(){
    const value = new URLSearchParams(location.search).get("pending") || "";
    return /^[A-Za-z0-9-]{1,100}$/.test(value) ? value : "";
  }

  function setExpanded(card, expanded){
    if(!card) return;
    const toggle = card.querySelector(":scope > .pendingWeatherToggle");
    const body = card.querySelector(":scope > .pendingWeatherBody");
    if(!toggle || !body) return;
    toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    body.hidden = !expanded;
  }

  function evidenceLabel(card){
    return card.querySelector("[data-weather-evidence]") ? "証拠画像あり" : "証拠画像なし";
  }

  function enhanceImageLinks(root){
    root.querySelectorAll?.(".pendingWeatherImages a[target='_blank']").forEach(link => {
      if(link.dataset.pendingImageEnhanced === "1") return;
      const image = link.querySelector("img");
      const src = safeImageUrl(image?.currentSrc || image?.src || link.href);
      if(!src || !image) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "pendingWeatherImageOpen";
      button.dataset.weatherImageOpen = src;
      button.dataset.weatherImageAlt = image.alt || "証拠画像";
      button.setAttribute("aria-label", `${image.alt || "証拠画像"}を拡大表示`);
      while(link.firstChild) button.appendChild(link.firstChild);
      link.replaceWith(button);
    });
  }

  function enhanceCard(card){
    if(!(card instanceof HTMLElement)) return;
    if(card.dataset.pendingReviewEnhanced !== "1"){
      const heading = Array.from(card.children).find(node => node.tagName === "STRONG");
      const title = heading?.textContent?.trim() || "未承認の天気報告";
      if(heading) heading.remove();

      const body = document.createElement("div");
      body.className = "pendingWeatherBody";
      while(card.firstChild) body.appendChild(card.firstChild);

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "pendingWeatherToggle";
      toggle.dataset.pendingWeatherToggle = "1";
      toggle.setAttribute("aria-expanded", "false");
      const hasEvidence = Boolean(body.querySelector("[data-weather-evidence]"));
      toggle.innerHTML = `
        <span class="pendingWeatherToggleMain">
          <span class="pendingWeatherToggleTitle"></span>
          <span class="pendingWeatherBadge${hasEvidence ? "" : " noEvidence"}">${hasEvidence ? "証拠画像あり" : "証拠画像なし"}</span>
        </span>
        <span class="pendingWeatherChevron" aria-hidden="true">⌄</span>
      `;
      toggle.querySelector(".pendingWeatherToggleTitle").textContent = title;
      card.append(toggle, body);
      card.dataset.pendingReviewEnhanced = "1";

      const shouldOpen = deepLinkId() && String(card.dataset.pendingWeatherId || "") === deepLinkId();
      setExpanded(card, shouldOpen);
    }

    const badge = card.querySelector(":scope > .pendingWeatherToggle .pendingWeatherBadge");
    if(badge){
      const label = evidenceLabel(card);
      badge.textContent = label;
      badge.classList.toggle("noEvidence", label === "証拠画像なし");
    }
    enhanceImageLinks(card);
  }

  function enhanceAll(host){
    host.querySelectorAll(".pendingWeatherCard").forEach(enhanceCard);
    enhanceImageLinks(host);
  }

  function setup(){
    injectStyles();
    const host = document.getElementById("pendingWeatherReports");
    if(!host) return;
    enhanceAll(host);

    if(host.dataset.pendingReviewUiReady === "1") return;
    host.dataset.pendingReviewUiReady = "1";

    host.addEventListener("click", event => {
      const toggle = event.target.closest("[data-pending-weather-toggle]");
      if(toggle){
        event.preventDefault();
        const card = toggle.closest(".pendingWeatherCard");
        setExpanded(card, toggle.getAttribute("aria-expanded") !== "true");
        return;
      }
      const imageButton = event.target.closest("[data-weather-image-open]");
      if(imageButton){
        event.preventDefault();
        openImage(imageButton.dataset.weatherImageOpen, imageButton.dataset.weatherImageAlt);
      }
    });

    const observer = new MutationObserver(() => enhanceAll(host));
    observer.observe(host, {childList:true, subtree:true});

    document.addEventListener("keydown", event => {
      if(event.key === "Escape") closeImage();
    });
  }

  window.HeartopiaPendingReviewUI = {setup, setExpanded, openImage, closeImage};
  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup, {once:true});
  else setup();
})();
