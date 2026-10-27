/* Basic consent: Google is not contacted until the visitor opts in. */
(function () {
  'use strict';
  const ID = 'G-6N7VWBC1C1';
  const BASE = 'https://sg-log.github.io/heartopia-daily/';
  const CONSENT = 'heartopiaAnalyticsConsent.v1';
  const EXCLUDED = 'heartopiaAccessExcluded.v1';
  const DISABLE = 'ga-disable-' + ID;
  let started = false;
  let settingsOpen = false;
  function read(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }
  function isExcluded() {
    const u = new URL(location.href);
    if (u.origin !== 'https://sg-log.github.io' ||
        !['/heartopia-daily/', '/heartopia-daily/index.html', '/heartopia-daily/codes.html'].includes(u.pathname)) return true;
    if (u.searchParams.has('admin') || u.searchParams.get('no_track') === '1' || navigator.webdriver) return true;
    if (!['', '#today', '#puzzles', '#about', '#weather', '#gift-codes'].includes(u.hash)) return true;
    try { if (localStorage.getItem(EXCLUDED) === '1') return true; } catch (_) { return true; }
    // Unknown query fields may contain private import/backup/admin information.
    if (Array.from(u.searchParams.keys()).some(key => !['utm_source', 'utm_medium', 'utm_campaign', 'analytics_debug', 'no_track'].includes(key))) return true;
    if (Array.from(u.searchParams.keys()).some(key => u.searchParams.getAll(key).length !== 1)) return true;
    const hasCampaign = ['utm_source', 'utm_medium', 'utm_campaign'].some(key => u.searchParams.has(key));
    if (hasCampaign && !(u.searchParams.get('utm_source') === 'discord' && u.searchParams.get('utm_medium') === 'social' && u.searchParams.get('utm_campaign') === 'friends')) return true;
    return false;
  }
  function referrer() {
    try {
      const u = new URL(document.referrer);
      return /^https?:$/.test(u.protocol) && u.origin !== location.origin ? u.origin + '/' : '';
    } catch (_) { return ''; }
  }
  function pageInfo() {
    const codes = location.pathname.endsWith('/codes.html');
    return {
      page_location: BASE + (codes ? 'codes.html' : ''),
      page_title: codes ? 'ハートピアのギフトコード一覧｜Heartopia Daily' : 'ハートピアの今日の採取場所・天気｜Heartopia Daily',
      page_referrer: referrer()
    };
  }
  function campaign() {
    const p = new URL(location.href).searchParams;
    // Only this deliberately chosen public channel label is copied into GA.
    if (p.get('utm_source') === 'discord' && p.get('utm_medium') === 'social' && p.get('utm_campaign') === 'friends') {
      return { campaign_source: 'discord', campaign_medium: 'social', campaign_name: 'friends' };
    }
    return {};
  }
  function clearAnalyticsCookies() {
    for (const item of document.cookie.split(';')) {
      const name = item.trim().split('=')[0];
      if (name !== '_ga' && name !== '_ga_6N7VWBC1C1') continue;
      document.cookie = name + '=; Max-Age=0; path=/heartopia-daily/; SameSite=Lax; Secure';
    }
  }
  function stop() {
    window[DISABLE] = true;
    clearAnalyticsCookies();
  }
  function start() {
    if (started || isExcluded() || read(CONSENT) !== 'granted') return;
    started = true;
    window[DISABLE] = false;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('consent', 'default', {
      analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied'
    });
    window.gtag('js', new Date());
    window.gtag('config', ID, Object.assign({
      send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false,
      cookie_domain: 'none', cookie_path: '/heartopia-daily/', cookie_expires: 60 * 60 * 24 * 395,
      cookie_flags: 'SameSite=Lax;Secure'
    }, pageInfo(), campaign(), new URL(location.href).searchParams.get('analytics_debug') === '1' ? { debug_mode: true } : {}));
    window.gtag('event', 'page_view', Object.assign({ send_to: ID }, pageInfo(), campaign()));
    const script = document.createElement('script');
    script.id = 'heartopia-ga4';
    script.async = true;
    script.referrerPolicy = 'no-referrer';
    script.src = 'https://www.googletagmanager.com/gtag/js?id=' + ID;
    document.head.appendChild(script);
  }
  function render() {
    document.querySelectorAll('[data-analytics-settings]').forEach(box => {
      const value = read(CONSENT);
      box.querySelector('[data-analytics-status]').textContent =
        isExcluded() && !location.pathname.endsWith('/privacy.html') ? 'この画面・端末は計測対象外です。' :
        value === 'granted' ? '利用状況の計測：許可しています。' : value === 'denied' ? '利用状況の計測：許可していません。' :
        'サイト改善のため、Googleアナリティクスで利用状況を計測してよいですか？';
      box.querySelector('[data-analytics-choices]').hidden = !!value && !settingsOpen && !box.hasAttribute('data-analytics-always-open');
      box.querySelector('[data-analytics-change]').hidden = !value || settingsOpen || box.hasAttribute('data-analytics-always-open');
    });
  }
  function setConsent(value) {
    try { localStorage.setItem(CONSENT, value); } catch (_) {
      document.querySelectorAll('[data-analytics-status]').forEach(el => { el.textContent = '設定を保存できないため、計測しません。'; });
      stop(); return;
    }
    settingsOpen = false;
    if (value === 'granted') start(); else stop();
    render();
    // Unload the already loaded library, including engagement timers, on withdrawal.
    if (value !== 'granted' && started) location.reload();
  }
  window.heartopiaAnalytics = { isExcluded };
  window[DISABLE] = true;
  function init() {
    document.querySelectorAll('[data-analytics-allow]').forEach(el => el.addEventListener('click', () => setConsent('granted')));
    document.querySelectorAll('[data-analytics-deny]').forEach(el => el.addEventListener('click', () => setConsent('denied')));
    document.querySelectorAll('[data-analytics-change]').forEach(el => el.addEventListener('click', () => { settingsOpen = true; render(); }));
    render(); start();
  }
  window.addEventListener('heartopia:access-exclusion-change', () => {
    if (isExcluded()) { stop(); if (started) location.reload(); } else start();
    render();
  });
  window.addEventListener('storage', event => {
    if (![CONSENT, EXCLUDED].includes(event.key) && event.key !== null) return;
    if (read(CONSENT) !== 'granted' || isExcluded()) { stop(); if (started) location.reload(); } else start();
    render();
  });
  window.addEventListener('hashchange', () => {
    if (isExcluded()) { stop(); if (started) location.reload(); }
    render();
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
}());
